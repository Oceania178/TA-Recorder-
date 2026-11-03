// Main's side of the hidden decoder page (src/renderer/decoder.ts). Main reads the Opus packets out of the
// WebM file (webm.ts) and sends them to the page in batches; the page decodes them with WebCodecs, brings them
// down to 16 kHz (downsample.ts) and sends the samples back; main appends them to the temp PCM file. So a long
// call never sits in memory whole, at 48 kHz or otherwise (controller decision, 29/10/2026).
// The transport is passed in (Electron IPC in main.ts, a fake page in tests). One file at a time.
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { floatToInt16 } from "./pcmFiles";
import { demuxWebmOpus, type OpusTrack } from "./webm";

export type DecoderRequest =
  | { kind: "open"; sid: number; codecPrivate: Uint8Array | null; sampleRate: number; channels: number }
  | { kind: "feed"; sid: number; packets: { t: number; data: Uint8Array }[] }
  | { kind: "close"; sid: number }
  | { kind: "loadFile"; sid: number; bytes: Uint8Array }
  | { kind: "readFile"; sid: number; channel: number; start: number; count: number };

export type DecoderReply = { sid: number; ok: true; pcm?: Float32Array; info?: { channels: number; frames: number; similar: boolean } } | { sid: number; ok: false; error: string };

export interface DecoderTransport {
  send(req: DecoderRequest): void;
  onReply(listener: (reply: DecoderReply) => void): void;
}

/** 500 Opus packets of 20 ms = 10 s of audio per round trip. */
const DEFAULT_BATCH = 500;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Decoding a whole imported file (up to 250 MB) in one go can take a while on a slow laptop. */
const LOAD_FILE_TIMEOUT_MS = 5 * 60_000;

/** D-171: what the page found in an imported file (decoded at 16 kHz). */
export interface FileInfo {
  channels: number;
  /** Samples per channel at 16 kHz. */
  frames: number;
  /** Two channels carrying the same sound (a mono recording saved as stereo). */
  similar: boolean;
}

interface Pending {
  resolve(r: { pcm?: Float32Array; info?: FileInfo }): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** A reply's samples as a Float32Array, whatever shape IPC delivered them in. */
function asFloat32(v: unknown): Float32Array | undefined {
  if (v instanceof Float32Array) return v;
  if (ArrayBuffer.isView(v)) return new Float32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  if (v instanceof ArrayBuffer) return new Float32Array(v);
  return undefined;
}

export class DecoderClient {
  private nextSid = 1;
  private readonly pending = new Map<number, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly batch: number;
  private readonly timeoutMs: number;

  constructor(private readonly transport: DecoderTransport, o: { batchPackets?: number; timeoutMs?: number } = {}) {
    this.batch = Math.max(1, o.batchPackets ?? DEFAULT_BATCH);
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    transport.onReply((r) => {
      const p = r && typeof r.sid === "number" ? this.pending.get(r.sid) : undefined;
      if (!p) return;
      this.pending.delete(r.sid);
      clearTimeout(p.timer);
      if (r.ok) p.resolve({ pcm: asFloat32(r.pcm), info: r.info });
      else p.reject(new Error(`Decoder failed: ${typeof r.error === "string" ? r.error : "unknown"}`));
    });
  }

  private ask(req: DecoderRequest): Promise<Float32Array | undefined> {
    return this.askFull(req).then((r) => r.pcm);
  }

  private askFull(req: DecoderRequest, timeoutMs = this.timeoutMs): Promise<{ pcm?: Float32Array; info?: FileInfo }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.sid);
        reject(new Error("Decoder timed out"));
      }, timeoutMs);
      this.pending.set(req.sid, { resolve, reject, timer });
      try {
        this.transport.send(req);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(req.sid);
        reject(e instanceof Error ? e : new Error("Decoder unavailable"));
      }
    });
  }

  /**
   * D-171: decode a whole imported file (any format Chromium reads: MP3, M4A/AAC, WAV, WebM/OGG Opus) at 16 kHz in
   * the page, then hand the channels `plan` picks to `write`, block by block. One file at a time, like tracks.
   * Channel -1 is the average of the channels (a mono call saved as stereo).
   */
  decodeFile(
    bytes: Uint8Array, plan: (info: FileInfo) => number[], write: (channel: number, pcm: Float32Array) => Promise<void>, blockSamples = 16_000 * 60,
  ): Promise<FileInfo> {
    const run = this.queue.then(() => this.runFile(bytes, plan, write, Math.max(1, blockSamples)));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runFile(
    bytes: Uint8Array, plan: (info: FileInfo) => number[], write: (channel: number, pcm: Float32Array) => Promise<void>, block: number,
  ): Promise<FileInfo> {
    const sid = this.nextSid++;
    try {
      const { info } = await this.askFull({ kind: "loadFile", sid, bytes }, LOAD_FILE_TIMEOUT_MS);
      if (!info || !(info.channels >= 1) || !(info.frames >= 0)) throw new Error("Decoder failed: no audio");
      for (const channel of plan(info)) {
        for (let start = 0; start < info.frames; start += block) {
          const pcm = await this.ask({ kind: "readFile", sid, channel, start, count: Math.min(block, info.frames - start) });
          if (pcm && pcm.length) await write(channel, pcm);
        }
      }
      return info;
    } finally {
      await this.ask({ kind: "close", sid }).catch(() => undefined);
    }
  }

  /** Decodes one track, handing each block of 16 kHz samples to `write` in order. */
  decode(track: OpusTrack, write: (pcm: Float32Array) => Promise<void>): Promise<{ samples: number }> {
    const run = this.queue.then(() => this.run(track, write));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(track: OpusTrack, write: (pcm: Float32Array) => Promise<void>): Promise<{ samples: number }> {
    const sid = this.nextSid++;
    let samples = 0;
    const emit = async (pcm: Float32Array | undefined) => {
      if (pcm && pcm.length) {
        samples += pcm.length;
        await write(pcm);
      }
    };
    try {
      await this.ask({ kind: "open", sid, codecPrivate: track.codecPrivate, sampleRate: track.sampleRate, channels: track.channels });
      for (let i = 0; i < track.packets.length; i += this.batch) {
        const packets = track.packets.slice(i, i + this.batch).map((p) => ({ t: p.timestampUs, data: p.data }));
        await emit(await this.ask({ kind: "feed", sid, packets }));
      }
      await emit(await this.ask({ kind: "close", sid }));
      return { samples };
    } catch (e) {
      // Free the page's decoder; its answer does not matter any more.
      try {
        this.transport.send({ kind: "close", sid });
      } catch {
        // page gone
      }
      throw e;
    }
  }
}

/** Decodes one mono WebM file into a raw 16-bit 16 kHz file (pcmFiles.ts's DecodeToFile). */
export async function decodeWebmToPcmFile(client: DecoderClient, webmFile: string, pcmFile: string): Promise<void> {
  const track = demuxWebmOpus(new Uint8Array(await readFile(webmFile)));
  const fh = await open(pcmFile, "w");
  try {
    await client.decode(track, async (pcm) => {
      const ints = floatToInt16(pcm);
      await fh.write(new Uint8Array(ints.buffer, ints.byteOffset, ints.byteLength));
    });
  } finally {
    await fh.close();
  }
}


/**
 * D-171: decode an imported file into the call folder's 16 kHz PCM files. Two different channels keep the app's
 * stereo layout (left = TA, right = candidate: <id>.left.s16 and <id>.right.s16); one channel, the same sound on
 * both, or forceMono ("both voices are on both channels") gives <id>.mono.s16.
 */
export async function decodeFileToPcm(
  client: DecoderClient, bytes: Uint8Array, outDir: string, id: string, o: { forceMono: boolean; blockSamples?: number },
): Promise<{ audio: "stereo" | "mono"; durationMs: number }> {
  let audio: "stereo" | "mono" = "mono";
  const files = new Map<number, Awaited<ReturnType<typeof open>>>();
  const nameFor = (channel: number) => join(outDir, `${id}.${channel === 0 ? "left" : channel === 1 ? "right" : "mono"}.s16`);
  try {
    const info = await client.decodeFile(bytes, (i) => {
      audio = i.channels >= 2 && !i.similar && !o.forceMono ? "stereo" : "mono";
      return audio === "stereo" ? [0, 1] : [i.channels >= 2 ? -1 : 0];
    }, async (channel, pcm) => {
      const key = audio === "mono" ? -1 : channel;
      let fh = files.get(key);
      if (!fh) {
        fh = await open(nameFor(key), "w");
        files.set(key, fh);
      }
      const ints = floatToInt16(pcm);
      await fh.write(new Uint8Array(ints.buffer, ints.byteOffset, ints.byteLength));
    }, o.blockSamples);
    return { audio, durationMs: Math.round((info.frames / 16_000) * 1000) };
  } finally {
    for (const fh of files.values()) await fh.close().catch(() => undefined);
  }
}
