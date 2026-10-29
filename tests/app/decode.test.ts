// Decoding for transcription: WebM/Opus packets out of the file (main), 48 kHz → 16 kHz in chunks (decoder page),
// the PCM temp files core's loadPcm reads, and the main-side client that talks to the hidden decoder page.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demuxWebmOpus } from "../../src/main/webm";
import { Downsampler } from "../../src/renderer/downsample";
import { deletePcmFiles, floatToInt16, makeLoadPcm, pcmPaths, PCM_SAMPLE_RATE } from "../../src/main/pcmFiles";
import { DecoderClient, type DecoderReply, type DecoderRequest } from "../../src/main/decoderClient";
import type { Job } from "../../src/core";

// ---- a tiny EBML writer, enough to build the WebM files MediaRecorder writes ----
function vintSize(n: number): number[] {
  if (n < 0x7f) return [0x80 | n];
  if (n < 0x3fff) return [0x40 | (n >> 8), n & 0xff];
  throw new Error("test helper: element too big");
}
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return out;
}
const el = (id: number, payload: number[]) => [...idBytes(id), ...vintSize(payload.length), ...payload];
const elUnknown = (id: number, payload: number[]) => [...idBytes(id), ...UNKNOWN, ...payload];
const uint = (n: number, bytes = 1) => Array.from({ length: bytes }, (_, i) => (n >> (8 * (bytes - 1 - i))) & 0xff);
const text = (s: string) => [...Buffer.from(s, "ascii")];
function simpleBlock(relMs: number, frame: number[]): number[] {
  const rel = relMs & 0xffff;
  return el(0xa3, [0x81, rel >> 8, rel & 0xff, 0x80, ...frame]);
}
const OPUS_HEAD = [...text("OpusHead"), 1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0];

function webm(o: { truncate?: number } = {}): Uint8Array {
  const header = el(0x1a45dfa3, [...el(0x4282, text("webm"))]);
  const info = el(0x1549a966, [...el(0x2ad7b1, uint(1_000_000, 3)), ...el(0x4d80, text("Chrome"))]);
  const audio = el(0xe1, [...el(0xb5, [0x47, 0x3b, 0x80, 0x00]), ...el(0x9f, [1])]); // 48000.0 as float32
  const tracks = el(0x1654ae6b, [...el(0xae, [...el(0xd7, [1]), ...el(0x86, text("A_OPUS")), ...el(0x63a2, OPUS_HEAD), ...audio])]);
  const cluster1 = elUnknown(0x1f43b675, [...el(0xe7, [0]), ...simpleBlock(0, [1, 1]), ...simpleBlock(20, [2, 2, 2])]);
  const cluster2 = elUnknown(0x1f43b675, [...el(0xe7, uint(1000, 2)), ...simpleBlock(0, [3]), ...simpleBlock(20, [4, 4, 4, 4])]);
  const bytes = [...header, ...elUnknown(0x18538067, [...info, ...tracks, ...cluster1, ...cluster2])];
  return new Uint8Array(o.truncate ? bytes.slice(0, bytes.length - o.truncate) : bytes);
}

describe("WebM/Opus demux", () => {
  it("finds the OpusHead and every packet with its time, across clusters of unknown size", () => {
    const t = demuxWebmOpus(webm());
    expect(t.sampleRate).toBe(48000);
    expect(t.channels).toBe(1);
    expect([...(t.codecPrivate ?? [])]).toEqual(OPUS_HEAD);
    expect(t.packets.map((p) => [p.timestampUs, [...p.data]])).toEqual([
      [0, [1, 1]], [20_000, [2, 2, 2]], [1_000_000, [3]], [1_020_000, [4, 4, 4, 4]],
    ]);
  });

  it("keeps the packets before a cut-off end (a crash-recovered file)", () => {
    const t = demuxWebmOpus(webm({ truncate: 3 }));
    expect(t.packets.map((p) => p.timestampUs)).toEqual([0, 20_000, 1_000_000]);
  });

  it("refuses a file that is not WebM", () => {
    expect(() => demuxWebmOpus(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow();
  });
});

describe("Downsampler 48 kHz → 16 kHz, in chunks", () => {
  const tone = (hz: number, n: number, rate = 48000) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));
  const rms = (a: Float32Array, from = 0, to = a.length) => {
    let s = 0;
    for (let i = from; i < to; i++) s += a[i] * a[i];
    return Math.sqrt(s / Math.max(1, to - from));
  };
  const run = (input: Float32Array, chunk: number) => {
    const d = new Downsampler(48000, 16000);
    const parts: Float32Array[] = [];
    for (let i = 0; i < input.length; i += chunk) parts.push(d.push(input.subarray(i, i + chunk)));
    parts.push(d.flush());
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };

  it("gives one sample for every three, the same whatever the chunk size", () => {
    const input = tone(440, 48000 + 7);
    const a = run(input, 1000);
    const b = run(input, 4801);
    const c = run(input, input.length);
    expect(a.length).toBe(Math.ceil(input.length / 3));
    expect(b.length).toBe(a.length);
    expect(c.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) {
      expect(Math.abs(a[i] - c[i])).toBeLessThan(1e-6);
      expect(Math.abs(b[i] - c[i])).toBeLessThan(1e-6);
    }
  });

  it("keeps speech frequencies and removes what 16 kHz cannot hold", () => {
    const keep = run(tone(1000, 48000), 999);
    const drop = run(tone(12000, 48000), 999);
    expect(rms(keep, 200, keep.length - 200)).toBeGreaterThan(0.69);
    expect(rms(keep, 200, keep.length - 200)).toBeLessThan(0.72);
    expect(rms(drop, 200, drop.length - 200)).toBeLessThan(0.02);
  });

  it("does not shift the audio in time", () => {
    const input = new Float32Array(4800);
    input[2400] = 1; // a click at 50 ms
    const out = run(input, 777);
    let peak = 0;
    for (let i = 1; i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[peak])) peak = i;
    expect(peak).toBe(800);
  });

  it("refuses a rate that is not a whole multiple of 16 kHz", () => {
    expect(() => new Downsampler(44100, 16000)).toThrow();
  });
});

describe("PCM temp files for core's loadPcm", () => {
  let folder: string;
  const ID = "cmh2x9k0a0001qz8v7y6t5r4e";
  const job = () => ({ id: ID, folder } as Job);
  beforeEach(async () => {
    folder = join(await mkdtemp(join(tmpdir(), "tacr-pcm-")), ID);
    await mkdir(folder, { recursive: true });
  });
  afterEach(async () => {
    await rm(join(folder, ".."), { recursive: true, force: true });
  });

  it("decodes each mono file once into a 16 kHz temp file, reads both, then the temp files can be deleted", async () => {
    await writeFile(join(folder, `${ID}.left.webm`), "L");
    await writeFile(join(folder, `${ID}.right.webm`), "R");
    const decoded: string[] = [];
    const loadPcm = makeLoadPcm(async (webmFile, pcmFile) => {
      decoded.push(webmFile);
      const v = webmFile.endsWith(".left.webm") ? 0.25 : -0.5;
      await writeFile(pcmFile, Buffer.from(floatToInt16(new Float32Array([v, v, v])).buffer));
    });
    const first = await loadPcm(job());
    expect(first?.sampleRate).toBe(PCM_SAMPLE_RATE);
    expect(PCM_SAMPLE_RATE).toBe(16000);
    expect([...(first?.left ?? [])].map((x) => Math.round(x * 1000) / 1000)).toEqual([0.25, 0.25, 0.25]);
    expect([...(first?.right ?? [])]).toEqual([-0.5, -0.5, -0.5]);
    expect(decoded).toHaveLength(2);
    await loadPcm(job()); // a retry reuses the temp files
    expect(decoded).toHaveLength(2);
    expect(existsSync(pcmPaths(folder, ID).left)).toBe(true);
    await deletePcmFiles(folder, ID);
    expect((await readdir(folder)).filter((f) => f.endsWith(".s16") || f.endsWith(".pcm"))).toEqual([]);
  });

  it("gives null when the audio is missing", async () => {
    const loadPcm = makeLoadPcm(async () => undefined);
    expect(await loadPcm(job())).toBeNull();
  });

  it("never keeps a half-written temp file when decoding fails", async () => {
    await writeFile(join(folder, `${ID}.left.webm`), "L");
    await writeFile(join(folder, `${ID}.right.webm`), "R");
    const loadPcm = makeLoadPcm(async (_w, pcmFile) => {
      await writeFile(pcmFile, "half");
      throw new Error("decoder failed");
    });
    await expect(loadPcm(job())).rejects.toThrow();
    expect((await readdir(folder)).filter((f) => f.includes(".s16") || f.includes(".pcm"))).toEqual([]);
  });
});

describe("DecoderClient (main ↔ hidden decoder page)", () => {
  /** A fake page: every packet decodes to as many samples as it has bytes, value = first byte. */
  function fakePage(o: { failOn?: DecoderRequest["kind"]; silent?: boolean } = {}) {
    const seen: DecoderRequest[] = [];
    let listener: (r: DecoderReply) => void = () => undefined;
    const transport = {
      send: (req: DecoderRequest) => {
        seen.push(req);
        if (o.silent) return;
        queueMicrotask(() => {
          if (o.failOn === req.kind) return listener({ sid: req.sid, ok: false, error: "decode_error" });
          if (req.kind === "feed") {
            const out: number[] = [];
            for (const p of req.packets) for (let i = 0; i < p.data.length; i++) out.push(p.data[0]);
            return listener({ sid: req.sid, ok: true, pcm: new Float32Array(out) });
          }
          listener({ sid: req.sid, ok: true, pcm: req.kind === "close" ? new Float32Array([9]) : undefined });
        });
      },
      onReply: (l: (r: DecoderReply) => void) => void (listener = l),
    };
    return { transport, seen };
  }
  const track = {
    sampleRate: 48000, channels: 1, codecPrivate: new Uint8Array([1]),
    packets: [1, 2, 3, 4, 5].map((v) => ({ timestampUs: v * 20_000, data: new Uint8Array([v, v]) })),
  };

  it("opens, feeds in batches, closes, and writes every chunk in order", async () => {
    const page = fakePage();
    const client = new DecoderClient(page.transport, { batchPackets: 2, timeoutMs: 1000 });
    const written: number[] = [];
    const r = await client.decode(track, async (pcm) => void written.push(...pcm));
    expect(page.seen.map((s) => s.kind)).toEqual(["open", "feed", "feed", "feed", "close"]);
    expect(written).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 9]);
    expect(r.samples).toBe(11);
  });

  it("fails cleanly on a decode error or when the page stops answering", async () => {
    await expect(new DecoderClient(fakePage({ failOn: "feed" }).transport, { timeoutMs: 1000 }).decode(track, async () => undefined)).rejects.toThrow(/decode_error/);
    await expect(new DecoderClient(fakePage({ silent: true }).transport, { timeoutMs: 50 }).decode(track, async () => undefined)).rejects.toThrow(/timed out/);
  });
});
