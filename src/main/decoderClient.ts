// Main's side of the hidden decoder page (src/renderer/decoder.ts). Main reads the Opus packets out of the
// WebM file (webm.ts) and sends them to the page in batches; the page decodes them with WebCodecs, brings them
// down to 16 kHz (downsample.ts) and sends the samples back; main appends them to the temp PCM file. So a long
// call never sits in memory whole, at 48 kHz or otherwise (controller decision, 29/10/2026).
// The transport is passed in (Electron IPC in main.ts, a fake page in tests). One file at a time.
import { open, readFile } from "node:fs/promises";
import { demuxWebmOpus, type OpusTrack } from "./webm";

export type DecoderRequest =
  | { kind: "open"; sid: number; codecPrivate: Uint8Array | null; sampleRate: number; channels: number }
  | { kind: "feed"; sid: number; packets: { t: number; data: Uint8Array }[] }
  | { kind: "close"; sid: number };

export type DecoderReply = { sid: number; ok: true; pcm?: Float32Array } | { sid: number; ok: false; error: string };

export interface DecoderTransport {
  send(req: DecoderRequest): void;
  onReply(listener: (reply: DecoderReply) => void): void;
}

/** 500 Opus packets of 20 ms = 10 s of audio per round trip. */
const DEFAULT_BATCH = 500;
const DEFAULT_TIMEOUT_MS = 60_000;

interface Pending {
  resolve(pcm: Float32Array | undefined): void;
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
      if (r.ok) p.resolve(asFloat32(r.pcm));
      else p.reject(new Error(`Decoder failed: ${typeof r.error === "string" ? r.error : "unknown"}`));
    });
  }

  private ask(req: DecoderRequest): Promise<Float32Array | undefined> {
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

/** Decodes one mono WebM file into a raw float32 16 kHz file (pcmFiles.ts's DecodeToFile). */
export async function decodeWebmToPcmFile(client: DecoderClient, webmFile: string, pcmFile: string): Promise<void> {
  const track = demuxWebmOpus(new Uint8Array(await readFile(webmFile)));
  const fh = await open(pcmFile, "w");
  try {
    await client.decode(track, async (pcm) => {
      await fh.write(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    });
  } finally {
    await fh.close();
  }
}
