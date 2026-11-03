// Main's side of the hidden decoder page (src/renderer/decoder.ts). Main reads the compressed packets out of the
// file (webm.ts for a live call, audioDemux.ts for an import) and sends them to the page in batches; the page
// decodes them with WebCodecs, brings them down to 16 kHz and sends the samples back; main appends them to the temp
// PCM file(s). So a long call never sits in memory whole, at 48 kHz or otherwise (controller decision, 29/10/2026;
// D-171 review R3 I2: imports too — measured: decodeAudioData held 3.5 GB for a 2 h stereo 48 kHz file).
// If the page dies, every waiting request fails at once (review R3 m4) instead of after the time-out.
// The transport is passed in (Electron IPC in main.ts, a fake page in tests). One file at a time.
import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { StreamResampler } from "../renderer/resample";
import { demuxAudio, type AudioTrack, type WavInfo } from "./audioDemux";
import { IMPORT_MESSAGES, MAX_IMPORT_MS } from "./importFlow";
import type { ImportLayout } from "./ipcTypes";
import { floatToInt16, openPcmReader } from "./pcmFiles";
import { demuxWebmOpus, type OpusTrack } from "./webm";

export type DecoderRequest =
  | {
      kind: "open"; sid: number; codecPrivate: Uint8Array | null; sampleRate: number; channels: number;
      /** WebCodecs codec; "opus" when absent (a live call). */
      codec?: string;
      /** Keep the first two channels apart (pcm = channel 0, pcm2 = channel 1) instead of mixing them. */
      stereo?: boolean;
    }
  | { kind: "feed"; sid: number; packets: { t: number; data: Uint8Array }[] }
  | { kind: "close"; sid: number };

export type DecoderReply = { sid: number; ok: true; pcm?: Float32Array; pcm2?: Float32Array } | { sid: number; ok: false; error: string };

export interface DecoderTransport {
  send(req: DecoderRequest): void;
  onReply(listener: (reply: DecoderReply) => void): void;
  /** The page went away (crashed or closed): pending requests fail now. */
  onGone?(listener: () => void): void;
}

/** 500 Opus packets of 20 ms = 10 s of audio per round trip. */
const DEFAULT_BATCH = 500;
const DEFAULT_TIMEOUT_MS = 60_000;

interface Pending {
  resolve(r: { pcm?: Float32Array; pcm2?: Float32Array }): void;
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
      if (r.ok) p.resolve({ pcm: asFloat32(r.pcm), pcm2: asFloat32(r.pcm2) });
      else p.reject(new Error(`Decoder failed: ${typeof r.error === "string" ? r.error : "unknown"}`));
    });
    transport.onGone?.(() => {
      for (const [sid, p] of this.pending) {
        clearTimeout(p.timer);
        this.pending.delete(sid);
        p.reject(new Error("Decoder stopped (the decoder page closed)"));
      }
    });
  }

  private ask(req: DecoderRequest): Promise<{ pcm?: Float32Array; pcm2?: Float32Array }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.sid);
        reject(new Error("Decoder timed out"));
      }, this.timeoutMs);
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

  /** Decodes one track to 16 kHz mono (a live call's .left / .right file), block by block, in order. */
  decode(track: OpusTrack, write: (pcm: Float32Array) => Promise<void>): Promise<{ samples: number }> {
    return this.decodeTrack({ ...track, codec: "opus" }, false, (pcm) => write(pcm));
  }

  /**
   * D-171: decodes any WebCodecs track (Opus, MP3, AAC) to 16 kHz; with `stereo`, channels 0 and 1 stay apart
   * (`right` is then set). Blocks come in order; nothing is held whole.
   */
  decodeTrack(
    track: AudioTrack, stereo: boolean, write: (left: Float32Array, right: Float32Array | undefined) => Promise<void>,
  ): Promise<{ samples: number }> {
    const run = this.queue.then(() => this.run(track, stereo, write));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(
    track: AudioTrack, stereo: boolean, write: (left: Float32Array, right: Float32Array | undefined) => Promise<void>,
  ): Promise<{ samples: number }> {
    const sid = this.nextSid++;
    let samples = 0;
    const emit = async (r: { pcm?: Float32Array; pcm2?: Float32Array }) => {
      if (r.pcm && r.pcm.length) {
        samples += r.pcm.length;
        await write(r.pcm, stereo ? (r.pcm2 ?? new Float32Array(r.pcm.length)) : undefined);
      }
    };
    try {
      const open: DecoderRequest = { kind: "open", sid, codecPrivate: track.codecPrivate, sampleRate: track.sampleRate, channels: track.channels };
      open.codec = track.codec;
      if (stereo) open.stereo = true;
      await this.ask(open);
      for (let i = 0; i < track.packets.length; i += this.batch) {
        // Copies: a view into the whole file would make IPC send the whole file with every batch (measured).
        const packets = track.packets.slice(i, i + this.batch).map((p) => ({ t: p.timestampUs, data: new Uint8Array(p.data) }));
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

// ---------------------------------------------------------------- D-171 imports

/** A WAV's frames, block by block, as float channels (decoded in main: it is already PCM). */
function* wavBlocks(bytes: Uint8Array, w: WavInfo, framesPerBlock: number): Generator<Float32Array[]> {
  const bps = w.bits / 8;
  const frameBytes = bps * w.channels;
  const total = Math.floor(w.dataBytes / frameBytes);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let f0 = 0; f0 < total; f0 += framesPerBlock) {
    const n = Math.min(framesPerBlock, total - f0);
    const ch = Array.from({ length: w.channels }, () => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < w.channels; c++) {
        const at = w.dataOffset + (f0 + i) * frameBytes + c * bps;
        let x: number;
        if (w.format === "float") x = v.getFloat32(at, true);
        else if (w.bits === 8) x = (bytes[at] - 128) / 128;
        else if (w.bits === 16) x = v.getInt16(at, true) / 32768;
        else if (w.bits === 24) x = ((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) << 8 >> 8) / 8388608;
        else x = v.getInt32(at, true) / 2147483648;
        ch[c][i] = x;
      }
    }
    yield ch;
  }
}

/**
 * D-171: decode an imported file into the call folder's 16 kHz PCM files, streaming (review R3 I2).
 * `layout` is the TA's answer for a two-channel file (review R3 I3):
 *   left-ta  — a TA Call Recorder stereo file: left = TA (<id>.left.s16), right = candidate (<id>.right.s16);
 *   right-ta — the same, the other way round;
 *   mixed    — both voices on both channels (and every one-channel file): <id>.mono.s16 (the speakers are told
 *              apart by Gemini, core/diarize.ts).
 * If the TA said stereo but both channels carry the same sound, the result goes the mono way (`sameOnBoth`).
 */
export async function decodeFileToPcm(
  client: DecoderClient, bytes: Uint8Array, ext: string, outDir: string, id: string, o: { layout: ImportLayout },
): Promise<{ audio: "stereo" | "mono"; durationMs: number; sameOnBoth: boolean }> {
  const d = demuxAudio(bytes, ext);
  if (!d.ok) throw new Error(d.message);
  const channels = d.kind === "wav" ? d.wav.channels : d.track.channels;
  const stereo = o.layout !== "mixed" && channels >= 2;
  const swap = o.layout === "right-ta";
  const files = { left: join(outDir, `${id}.left.s16`), right: join(outDir, `${id}.right.s16`), mono: join(outDir, `${id}.mono.s16`) };
  const out = stereo ? { a: await open(files.left, "w"), b: await open(files.right, "w") } : { a: await open(files.mono, "w"), b: null };
  let diff = 0;
  let energy = 0;
  // Review R3-2 f3: whatever the header said, decoding stops past 2 hours of output (1 s of slack).
  const maxSamples = (MAX_IMPORT_MS / 1000 + 1) * 16_000;
  let written = 0;
  const put = async (fh: Awaited<ReturnType<typeof open>>, pcm: Float32Array) => {
    const ints = floatToInt16(pcm);
    await fh.write(new Uint8Array(ints.buffer, ints.byteOffset, ints.byteLength));
  };
  const write = async (first: Float32Array, second: Float32Array | undefined) => {
    written += first.length;
    if (written > maxSamples) throw new Error(IMPORT_MESSAGES.tooLong);
    if (!stereo || !second) return put(out.a, first);
    const n = Math.min(first.length, second.length);
    for (let i = 0; i < n; i += 4) {
      const x = first[i] - second[i];
      diff += x * x;
      energy += first[i] * first[i] + second[i] * second[i];
    }
    const [ta, cand] = swap ? [second, first] : [first, second];
    await put(out.a, ta);
    if (out.b) await put(out.b, cand);
  };
  try {
    if (d.kind === "wav") {
      const rs = stereo ? [new StreamResampler(d.wav.sampleRate), new StreamResampler(d.wav.sampleRate)] : [new StreamResampler(d.wav.sampleRate)];
      for (const block of wavBlocks(bytes, d.wav, d.wav.sampleRate)) {
        if (stereo) await write(rs[0].push(block[0]), rs[1].push(block[1]));
        else {
          const mix = new Float32Array(block[0].length);
          for (const ch of block) for (let i = 0; i < mix.length; i++) mix[i] += ch[i] / block.length;
          await write(rs[0].push(mix), undefined);
        }
      }
      if (stereo) await write(rs[0].flush(), rs[1].flush());
      else await write(rs[0].flush(), undefined);
    } else {
      await client.decodeTrack(d.track, stereo, write);
    }
  } finally {
    await out.a.close().catch(() => undefined);
    await out.b?.close().catch(() => undefined);
  }
  if (stereo && energy > 0 && diff / energy < 0.01) {
    // Two channels, one sound (a mono call saved as stereo): the mono path, so nothing is said twice.
    await averageToMono(files.left, files.right, files.mono);
    await rm(files.left, { force: true });
    await rm(files.right, { force: true });
    return { audio: "mono", durationMs: d.durationMs, sameOnBoth: true };
  }
  return { audio: stereo ? "stereo" : "mono", durationMs: d.durationMs, sameOnBoth: false };
}

async function averageToMono(left: string, right: string, mono: string): Promise<void> {
  const l = await openPcmReader(left);
  const r = await openPcmReader(right);
  const fh = await open(mono, "w");
  try {
    const n = Math.min(l.length, r.length);
    for (let at = 0; at < n; at += 160_000) {
      const a = await l.read(at, Math.min(160_000, n - at));
      const b = await r.read(at, a.length);
      const m = new Float32Array(a.length);
      for (let i = 0; i < m.length; i++) m[i] = (a[i] + b[i]) / 2;
      const ints = floatToInt16(m);
      await fh.write(new Uint8Array(ints.buffer, ints.byteOffset, ints.byteLength));
    }
  } finally {
    await fh.close();
    await l.close();
    await r.close();
  }
}
