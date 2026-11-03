// D-171 "Import recording" — fix round 1 (review R3): I1 an import session belongs to one attempt; I2 the length
// is known before decoding and decoding streams (memory follows 10 s batches, not the file); I3 a two-channel file
// is never assumed to be TA-left / candidate-right without the TA saying so; m1–m6.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { speakerPreview } from "../../src/core/diarize";
import { transcribeMonoJob, readSpeakersFile } from "../../src/core/mono";
import type { FetchLike } from "../../src/core/http";
import { demuxAudio, inspectAudio, looksLikeAppRecording } from "../../src/main/audioDemux";
import { DecoderClient, decodeFileToPcm, type DecoderReply, type DecoderRequest } from "../../src/main/decoderClient";
import { DISCARDED_FAILED, ImportCoordinator, type CoordinatorDeps } from "../../src/main/importCoordinator";
import { runImport, type ImportDeps } from "../../src/main/importFlow";
import { recoverLeftovers } from "../../src/main/recovery";
import { DISCARDED_FLAG } from "../../src/main/chunkStore";
import { layoutDefault } from "../../src/renderer/importText";
import { StreamResampler } from "../../src/renderer/resample";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "tcr-fix1-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- synthetic files (invented tones, no voice)
function wav(o: { rate: number; channels: number; seconds: number; bits?: 16 | 24 | 32; float?: boolean; same?: boolean }): Buffer {
  const bits = o.float ? 32 : o.bits ?? 16;
  const n = Math.round(o.rate * o.seconds);
  const bps = bits / 8;
  const data = Buffer.alloc(n * o.channels * bps);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < o.channels; c++) {
      const v = 0.4 * Math.sin((2 * Math.PI * (c === 0 || o.same ? 330 : 660) * i) / o.rate);
      const at = (i * o.channels + c) * bps;
      if (o.float) data.writeFloatLE(v, at);
      else if (bits === 16) data.writeInt16LE(Math.round(v * 32767), at);
      else if (bits === 24) data.writeIntLE(Math.round(v * 8388607), at, 3);
      else data.writeInt32LE(Math.round(v * 2147483647), at);
    }
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(o.float ? 3 : 1, 20); h.writeUInt16LE(o.channels, 22); h.writeUInt32LE(o.rate, 24);
  h.writeUInt32LE(o.rate * o.channels * bps, 28); h.writeUInt16LE(o.channels * bps, 32); h.writeUInt16LE(bits, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** MP3 frames with an empty payload: MPEG-1 Layer III, 128 kbps, 44.1 kHz (417 bytes each), after an ID3v2 tag. */
function mp3(frames: number, mono = false): Buffer {
  const id3 = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 10, ...new Array(10).fill(0)]);
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, mono ? 0xc4 : 0x64]);
  return Buffer.concat([id3, ...Array.from({ length: frames }, () => frame)]);
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
function oggPage(packets: Buffer[], granule: number, seq: number, flags: number): Buffer {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  const h = Buffer.alloc(27 + lacing.length);
  h.write("OggS", 0); h[5] = flags; h.writeBigInt64LE(BigInt(granule), 6); h.writeUInt32LE(7, 14); h.writeUInt32LE(seq, 18);
  h[26] = lacing.length; Buffer.from(lacing).copy(h, 27);
  const pg = Buffer.concat([h, ...packets]);
  let c = 0;
  for (const b of pg) c = ((c << 8) ^ CRC[((c >>> 24) ^ b) & 0xff]) >>> 0;
  pg.writeUInt32LE(c, 22);
  return pg;
}
/** Ogg Opus: `count` 20 ms stereo packets (TOC 0xFC: CELT FB 20 ms, stereo, one frame). */
function oggOpus(count: number, codec: "OpusHead" | "\u0001vorbis" = "OpusHead"): Buffer {
  const head = Buffer.alloc(19);
  head.write(codec, 0); head[8] = 1; head[9] = 2; head.writeUInt16LE(312, 10); head.writeUInt32LE(48000, 12);
  const tags = Buffer.concat([Buffer.from("OpusTags"), Buffer.from([0, 0, 0, 0]), Buffer.alloc(4)]);
  const pages = [oggPage([head], 0, 0, 2), oggPage([tags], 0, 1, 0)];
  const pkts = Array.from({ length: count }, (_, i) => Buffer.from([0xfc, i & 0xff, 1, 2, 3]));
  let granule = 312;
  for (let i = 0; i < pkts.length; i += 50) {
    const g = pkts.slice(i, i + 50);
    granule += g.length * 960;
    pages.push(oggPage(g, granule, 2 + i / 50, i + 50 >= pkts.length ? 4 : 0));
  }
  return Buffer.concat(pages);
}

const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0); h.write(type, 4);
  return Buffer.concat([h, body]);
};
const u32 = (...v: number[]) => { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => b.writeUInt32BE(x, i * 4)); return b; };
const u16 = (...v: number[]) => { const b = Buffer.alloc(2 * v.length); v.forEach((x, i) => b.writeUInt16BE(x, i * 2)); return b; };
/** An M4A (AAC LC, 44.1 kHz stereo): `frames` samples of 10 bytes in one chunk, moov before mdat. */
function m4a(frames: number): Buffer {
  const asc = Buffer.from([0x12, 0x10]);
  const esds = box("esds", u32(0), Buffer.from([3, 25, 0, 1, 0, 4, 17, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 2]), asc, Buffer.from([6, 1, 2]));
  const mp4a = box("mp4a", Buffer.alloc(6), u16(1), Buffer.alloc(8), u16(2, 16, 0, 0), u32(44100 * 65536), esds);
  const stsd = box("stsd", u32(0, 1), mp4a);
  const stts = box("stts", u32(0, 1, frames, 1024));
  const stsc = box("stsc", u32(0, 1, 1, frames, 1));
  const stsz = box("stsz", u32(0, 0, frames), ...Array.from({ length: frames }, () => u32(10)));
  const head = (offset: number) => {
    const stco = box("stco", u32(0, 1, offset));
    const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
    const minf = box("minf", stbl);
    const hdlr = box("hdlr", u32(0, 0), Buffer.from("soun"), u32(0, 0, 0), Buffer.from([0]));
    const mdhd = box("mdhd", u32(0, 0, 0, 44100, frames * 1024), u16(0, 0));
    return Buffer.concat([box("ftyp", Buffer.from("M4A "), u32(0), Buffer.from("isomM4A ")), box("moov", box("trak", box("mdia", mdhd, hdlr, minf))), Buffer.alloc(8)]);
  };
  const first = head(0);
  const real = head(first.length);
  const mdat = Buffer.concat(Array.from({ length: frames }, (_, i) => Buffer.alloc(10, i & 0xff)));
  const out = Buffer.concat([real.subarray(0, real.length - 8), box("mdat", mdat)]);
  return out;
}

// ---------------------------------------------------------------- I2: the length before decoding
describe("I2: every format is read without decoding: its length and channels first", () => {
  it("WAV: 16-bit, 24-bit, float; any rate; exact length", () => {
    expect(inspectAudio(wav({ rate: 48000, channels: 2, seconds: 3 }), ".wav")).toEqual({ ok: true, format: "wav", channels: 2, durationMs: 3000 });
    expect(inspectAudio(wav({ rate: 8000, channels: 1, seconds: 2, bits: 24 }), ".wav")).toMatchObject({ ok: true, channels: 1, durationMs: 2000 });
    expect(inspectAudio(wav({ rate: 44100, channels: 1, seconds: 1, float: true }), ".wav")).toMatchObject({ ok: true, durationMs: 1000 });
  });

  it("MP3: frames are counted (ID3 tag skipped), mono or stereo", () => {
    expect(inspectAudio(mp3(100), ".mp3")).toEqual({ ok: true, format: "mp3", channels: 2, durationMs: Math.round((100 * 1152 * 1000) / 44100) });
    expect(inspectAudio(mp3(10, true), ".mp3")).toMatchObject({ ok: true, channels: 1 });
    const d = demuxAudio(mp3(3), ".mp3");
    expect(d.ok && d.kind === "packets" && d.track).toMatchObject({ codec: "mp3", sampleRate: 44100, channels: 2 });
    expect(d.ok && d.kind === "packets" && d.track.packets.length).toBe(3);
  });

  it("OGG: Opus packets and length from the granule; Vorbis is refused in plain words", () => {
    expect(inspectAudio(oggOpus(250), ".ogg")).toEqual({ ok: true, format: "ogg", channels: 2, durationMs: 5000 });
    const d = demuxAudio(oggOpus(3), ".opus");
    expect(d.ok && d.kind === "packets" && d.track).toMatchObject({ codec: "opus", sampleRate: 48000, channels: 2 });
    expect(d.ok && d.kind === "packets" && d.track.packets.map((p) => p.timestampUs)).toEqual([0, 20000, 40000]);
    expect(inspectAudio(oggOpus(3, "\u0001vorbis"), ".ogg")).toEqual({ ok: false, message: "This OGG file is not Opus audio. Export the recording as MP3 or WAV, then import it." });
  });

  it("M4A: the AAC track, its decoder config and samples from the sample tables", () => {
    expect(inspectAudio(m4a(431), ".m4a")).toEqual({ ok: true, format: "m4a", channels: 2, durationMs: Math.round((431 * 1024 * 1000) / 44100) });
    const d = demuxAudio(m4a(3), ".m4a");
    expect(d.ok && d.kind === "packets" && d.track.codec).toBe("mp4a.40.2");
    expect(d.ok && d.kind === "packets" && Array.from(d.track.codecPrivate ?? [])).toEqual([0x12, 0x10]);
    expect(d.ok && d.kind === "packets" && d.track.packets.map((p) => [p.data.length, p.data[0]])).toEqual([[10, 0], [10, 1], [10, 2]]);
  });

  it("M4A written in fragments (as MediaRecorder and some phones do): samples from moof / trun, length from them", () => {
    const frames = 431;
    const esds = box("esds", u32(0), Buffer.from([3, 25, 0, 1, 0, 4, 17, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 2]), Buffer.from([0x12, 0x10]), Buffer.from([6, 1, 2]));
    const mp4a = box("mp4a", Buffer.alloc(6), u16(1), Buffer.alloc(8), u16(2, 16, 0, 0), u32(44100 * 65536), esds);
    const stbl = box("stbl", box("stsd", u32(0, 1), mp4a), box("stts", u32(0, 0)), box("stsc", u32(0, 0)), box("stsz", u32(0, 0, 0)), box("stco", u32(0, 0)));
    const hdlr = box("hdlr", u32(0, 0), Buffer.from("soun"), u32(0, 0, 0), Buffer.from([0]));
    const moov = box("moov", box("trak", box("mdia", box("mdhd", u32(0, 0, 0, 44100, 1024), u16(0, 0)), hdlr, box("minf", stbl)))); // a placeholder length, as MediaRecorder writes
    const trunBody = (offset: number) => Buffer.concat([u32(0x000201, frames, offset), ...Array.from({ length: frames }, () => u32(10))]);
    const tfhd = box("tfhd", u32(0x020000, 1));
    const moofLen = 8 + (8 + 8) /* mfhd */ + (8 + tfhd.length + 8 + trunBody(0).length);
    const moof = box("moof", box("mfhd", u32(0, 1)), box("traf", tfhd, box("trun", trunBody(moofLen + 8))));
    const file = Buffer.concat([box("ftyp", Buffer.from("iso6"), u32(0)), moov, moof, box("mdat", Buffer.alloc(frames * 10, 7))]);
    expect(inspectAudio(file, ".m4a")).toEqual({ ok: true, format: "m4a", channels: 2, durationMs: Math.round((frames * 1024 * 1000) / 44100) });
  });

  it("an unreadable file is refused before anything is decoded", () => {
    expect(inspectAudio(Buffer.from("not audio at all"), ".mp3")).toEqual({ ok: false, message: "The app could not read this recording. Try another file, or export it again as MP3 or WAV." });
  });

  it("a file over 2 hours is refused at the pick, before the live recording is discarded and before decoding", async () => {
    const calls: string[] = [];
    const c = coordinator({ inspect: async () => (calls.push("inspect"), { ok: true, name: "long.ogg", sizeMb: 20, durationMs: 2 * 3600_000 + 1000, channels: 2, looksLikeAppFile: false }) }, calls);
    expect(await c.choose()).toEqual({ ok: false, message: "This recording is longer than 2 hours. Import a recording of up to 2 hours." });
    expect(calls).toEqual(["pick", "inspect"]);
  });

  it("decoding streams: the page gets one batch at a time and nothing is held whole (a resampler for any rate)", () => {
    const r = new StreamResampler(44100, 16000);
    let out = 0;
    for (let i = 0; i < 44; i++) out += r.push(new Float32Array(1000).fill(0.25)).length;
    out += r.flush().length;
    expect(Math.abs(out - Math.round((44000 * 16000) / 44100))).toBeLessThanOrEqual(2);
    const tone = Float32Array.from({ length: 44100 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 44100));
    const y = Float32Array.from([...new StreamResampler(44100, 16000).push(tone)]);
    const rms = Math.sqrt(y.slice(1000, 15000).reduce((a, v) => a + v * v, 0) / 14000);
    expect(rms).toBeGreaterThan(0.65);
    expect(rms).toBeLessThan(0.75);
  });
});

// ---------------------------------------------------------------- decodeFileToPcm with the layout
function fakePage(o: { fail?: boolean; same?: boolean } = {}) {
  let listener: (r: DecoderReply) => void = () => undefined;
  let gone: () => void = () => undefined;
  const seen: DecoderRequest[] = [];
  const sessions = new Map<number, boolean>();
  return {
    seen,
    crash: () => gone(),
    transport: {
      onReply: (l: (r: DecoderReply) => void) => { listener = l; },
      onGone: (l: () => void) => { gone = l; },
      send: (req: DecoderRequest) => {
        seen.push(req);
        if (o.fail === true && req.kind === "feed") return; // a page that never answers
        queueMicrotask(() => {
          if (req.kind === "open") { sessions.set(req.sid, req.stereo === true); return listener({ sid: req.sid, ok: true }); }
          const stereo = sessions.get(req.sid);
          const n = req.kind === "feed" ? req.packets.length * 320 : 0;
          const left = new Float32Array(n).fill(0.3);
          const right = new Float32Array(n).fill(o.same ? 0.3 : -0.2);
          listener({ sid: req.sid, ok: true, pcm: stereo ? left : left, pcm2: stereo ? right : undefined });
        });
      },
    },
  };
}

describe("I3: two channels are TA-left / candidate-right only when the TA says so", () => {
  it("layout left-ta / right-ta / mixed; WAV decoded in main at 16 kHz", async () => {
    const file = wav({ rate: 48000, channels: 2, seconds: 1 });
    const client = new DecoderClient(fakePage().transport);
    expect(await decodeFileToPcm(client, file, ".wav", dir, "lt-0000001", { layout: "left-ta" })).toMatchObject({ audio: "stereo", durationMs: 1000 });
    expect((await stat(path.join(dir, "lt-0000001.left.s16"))).size).toBe(32000);
    await decodeFileToPcm(client, file, ".wav", dir, "rt-0000001", { layout: "right-ta" });
    const l = await readFile(path.join(dir, "lt-0000001.left.s16"));
    const swappedRight = await readFile(path.join(dir, "rt-0000001.right.s16"));
    expect(Buffer.compare(l, swappedRight)).toBe(0); // "I'm on the right": the file's right channel is the TA
    expect((await decodeFileToPcm(client, file, ".wav", dir, "mx-0000001", { layout: "mixed" })).audio).toBe("mono");
    expect(existsSync(path.join(dir, "mx-0000001.mono.s16"))).toBe(true);
  });

  it("the TA said 'app stereo' but both channels carry the same sound: it goes the mono way, and says so", async () => {
    const r = await decodeFileToPcm(new DecoderClient(fakePage().transport), wav({ rate: 16000, channels: 2, seconds: 1, same: true }), ".wav", dir, "same-000001", { layout: "left-ta" });
    expect(r).toMatchObject({ audio: "mono", sameOnBoth: true });
  });

  it("compressed files stream through the page batch by batch, stereo kept apart", async () => {
    const page = fakePage();
    const r = await decodeFileToPcm(new DecoderClient(page.transport, { batchPackets: 100 }), oggOpus(250), ".ogg", dir, "ogg-0000001", { layout: "left-ta" });
    expect(r).toMatchObject({ audio: "stereo", durationMs: 5000 });
    expect(page.seen.filter((q) => q.kind === "feed").length).toBe(3);
    expect(page.seen[0]).toMatchObject({ kind: "open", codec: "opus", stereo: true });
    expect((await stat(path.join(dir, "ogg-0000001.right.s16"))).size).toBe(250 * 320 * 2);
  });

  it("each batch carries copies of its packets, never a view of the whole file (IPC would copy the whole file each time)", async () => {
    const page = fakePage();
    await decodeFileToPcm(new DecoderClient(page.transport, { batchPackets: 100 }), oggOpus(250), ".ogg", dir, "ogg-0000002", { layout: "mixed" });
    const feeds = page.seen.filter((q): q is Extract<DecoderRequest, { kind: "feed" }> => q.kind === "feed");
    expect(feeds.every((q) => q.packets.every((p) => p.data.byteOffset === 0 && p.data.buffer.byteLength === p.data.byteLength))).toBe(true);
  });

  it("the question's default: 'mixed' unless the name is one of this app's recordings", () => {
    expect(looksLikeAppRecording("20261029-140305-a1b2c3.webm")).toBe(true);
    expect(looksLikeAppRecording("cmw07xoms000osha7a391nqln.webm")).toBe(true);
    expect(looksLikeAppRecording("cmw07xoms000osha7a391nqln.left.webm")).toBe(false);
    expect(looksLikeAppRecording("Ghi âm 0901.m4a")).toBe(false);
    expect(layoutDefault(true)).toBe("left-ta");
    expect(layoutDefault(false)).toBe("mixed");
  });
});

describe("m4: a crashed decoder page fails at once, not after the time-out", () => {
  it("pending requests are rejected when the page goes away", async () => {
    const page = fakePage({ fail: true });
    const client = new DecoderClient(page.transport, { timeoutMs: 60_000 });
    const t0 = Date.now();
    const p = decodeFileToPcm(client, oggOpus(10), ".ogg", dir, "crash-00001", { layout: "mixed" });
    setTimeout(() => page.crash(), 20);
    await expect(p).rejects.toThrow(/decoder stopped/i);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------- I1: the session belongs to one attempt
const S = { sessionId: "sess-x-candidate-01", dialMode: "3cx" as const, sendBy: "2099-01-01T00:00:00Z" };

function coordinator(over: Partial<CoordinatorDeps> = {}, calls: string[] = [], state = { noticeAccepted: true, testMode: true, liveLinkedCallId: S.sessionId as string | null, recording: true }) {
  const runs: unknown[] = [];
  const c = new ImportCoordinator({
    state: () => state,
    pickFile: async () => { calls.push("pick"); return "C:\\phone\\rec.m4a"; },
    inspect: async () => { calls.push("inspect"); return { ok: true, name: "rec.m4a", sizeMb: 3, durationMs: 600_000, channels: 1, looksLikeAppFile: false }; },
    takeLiveSession: async () => { calls.push("discard"); state.liveLinkedCallId = null; state.recording = false; return { ok: true, session: S }; },
    run: async (o) => { calls.push("run"); runs.push(o); return { ok: true, id: o.session?.sessionId ?? "local-1", audio: "mono", fromFileTime: true, durationMs: 600_000 }; },
    ...over,
  });
  return Object.assign(c, { runs, state });
}

describe("I1: a Solace session from a discarded live recording is used by that one import only", () => {
  it("discard → failed import → a later Test-mode import is Local only (the exact review sequence)", async () => {
    let fail = true;
    const c = coordinator({ run: async (o) => { c.runs.push(o); return fail ? { ok: false, message: "The app could not read the audio in this file." } : { ok: true, id: "local-2", audio: "mono", fromFileTime: true, durationMs: 1 }; } });
    const pick = await c.choose();
    expect(pick).toMatchObject({ ok: true, channels: 1, forLive: true });
    expect(await c.discard(S.sessionId)).toEqual({ ok: true });
    const r = await c.run(pick.ok ? pick.token : "", "mixed");
    expect(r).toEqual({ ok: false, message: `The app could not read the audio in this file. ${DISCARDED_FAILED}` });
    expect(DISCARDED_FAILED).toBe("The recording for this Solace call was discarded and the import failed. Press Call & record in Solace again.");
    expect(c.hasSession()).toBe(false);
    // later, in Test mode, nothing live: a role-play file
    fail = false;
    const pick2 = await c.choose();
    expect(pick2).toMatchObject({ ok: true, forLive: false });
    await c.run(pick2.ok ? pick2.token : "", "mixed");
    expect(c.runs.at(-1)).toMatchObject({ session: null });
  });

  it("closing the dialog, a new Solace link or a local start ends the attempt; an old token is refused", async () => {
    const c = coordinator();
    const pick = await c.choose();
    await c.discard(S.sessionId);
    c.cancel();
    expect(c.hasSession()).toBe(false);
    expect(await c.run(pick.ok ? pick.token : "", "mixed")).toEqual({ ok: false, message: "Choose the file again." });
    const c2 = coordinator();
    const p2 = await c2.choose();
    await c2.discard(S.sessionId);
    c2.newCallStarted();
    expect(c2.hasSession()).toBe(false);
    expect((await c2.run(p2.ok ? p2.token : "", "mixed")).ok).toBe(false);
  });

  it("a pick made for a live Solace call never becomes a Local only import (no discard → refused)", async () => {
    const c = coordinator();
    const pick = await c.choose();
    expect(await c.run(pick.ok ? pick.token : "", "mixed")).toEqual({ ok: false, message: "The live recording was not replaced. Choose \"Import a recording instead…\" again." });
    expect(c.runs).toEqual([]);
  });

  it("the gates: notice, Test mode, one at a time; a successful import uses the session once", async () => {
    const calls: string[] = [];
    const c = coordinator({}, calls, { noticeAccepted: false, testMode: true, liveLinkedCallId: null, recording: false });
    expect(await c.choose()).toEqual({ ok: false, message: "Open Set-up check and accept the notice first." });
    const c2 = coordinator({}, [], { noticeAccepted: true, testMode: false, liveLinkedCallId: null, recording: false });
    expect((await c2.choose()).ok).toBe(false);
    const c3 = coordinator();
    const p = await c3.choose();
    await c3.discard(S.sessionId);
    expect(await c3.run(p.ok ? p.token : "", "mixed")).toMatchObject({ ok: true, linked: true });
    expect(c3.runs[0]).toMatchObject({ session: S, layout: "mixed" });
    expect(c3.hasSession()).toBe(false);
  });

  it("a live recording that cannot be deleted is not replaced, and the TA is told", async () => {
    const c = coordinator({ takeLiveSession: async () => ({ ok: false, message: "The live recording could not be deleted now. It is deleted when the app starts again and is never sent. Press Call & record in Solace again." }) });
    await c.choose();
    expect(await c.discard(S.sessionId)).toEqual({ ok: false, message: "The live recording could not be deleted now. It is deleted when the app starts again and is never sent. Press Call & record in Solace again." });
    expect(c.hasSession()).toBe(false);
  });
});

// ---------------------------------------------------------------- m3: a discarded live recording is never recovered
describe("m3: a live recording discarded for an import is never recovered or sent", () => {
  it("recovery deletes an .in-progress folder marked discarded instead of recovering it", async () => {
    const id = "sess-discarded-0001";
    const folder = path.join(dir, ".in-progress", id);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, `${id}.webm.part`), Buffer.alloc(500, 1));
    await writeFile(path.join(folder, DISCARDED_FLAG), "");
    const r = await recoverLeftovers(dir);
    expect(r.recovered).toEqual([]);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(path.join(dir, id))).toBe(false);
  });
});

// ---------------------------------------------------------------- m1, m2: the mono path's gaps and doubts
function monoReader(seconds: number) {
  const pcm = new Float32Array(seconds * 16_000).fill(0.1);
  return { length: pcm.length, read: async (s: number, n: number) => pcm.subarray(s, s + n) };
}

describe("m1 / m2: a refused part and a part without overlap evidence are shown, not hidden", () => {
  it("a part Gemini refuses (400) becomes one '[không nghe rõ]' turn, marked; a part with no overlap turns is 'check this part'", async () => {
    let n = 0;
    const fetch: FetchLike = async () => {
      n++;
      if (n === 2) return { status: 400, headers: { get: () => null }, text: async () => "bad" };
      const text = n === 1 ? "A 00:01 | Chào em\nB 00:04 | Dạ" : "A 00:30 | Cảm ơn em";
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }) };
    };
    const job = { id: "mono-gap-0001", sessionId: null, dialMode: null, folder: dir, startedAt: "2026-11-03T09:00:00+07:00", endedAt: "2026-11-03T09:15:00+07:00", sendBy: null, stage: "recorded", attempts: 0, nextAttemptAt: null, callId: null, duplicate: false, failure: null, createdAt: "", updatedAt: "" } as never;
    const out = await transcribeMonoJob({ openMono: async () => monoReader(900), getGeminiKey: async () => "k", getModel: () => "m", gemini: { fetch, sleep: async () => undefined, maxAttempts: 1 }, appVersion: "x" }, job);
    expect(out).toEqual({ ok: true, needsSpeakers: true });
    const s = await readSpeakersFile(dir, "mono-gap-0001");
    const gap = s?.turns.filter((t) => t.chunk === 1);
    expect(gap).toEqual([{ chunk: 1, label: "A", start_ms: 300_000, end_ms: 605_000, text: "[không nghe rõ]", unclear: true }]);
    expect(s?.unsure).toEqual([false, true, true]);
    const p = speakerPreview(s!);
    expect(p.chunks.map((c) => [c.unclear, c.unsure])).toEqual([[false, false], [true, true], [false, true]]);
  });
});

// ---------------------------------------------------------------- m6: the source file is never touched
describe("m6: the source file's bytes and modified time are unchanged after an import", () => {
  it("copy only", async () => {
    const src = path.join(dir, "phone", "rec.wav");
    await mkdir(path.dirname(src), { recursive: true });
    const bytes = wav({ rate: 16000, channels: 1, seconds: 1 });
    await writeFile(src, bytes);
    const mtime = Date.parse("2026-11-01T02:30:00Z") / 1000;
    await utimes(src, mtime, mtime);
    const d: ImportDeps = {
      root: path.join(dir, "Recordings"), dirProblem: () => null, hasCall: () => false, newLocalId: () => "20261103-100000-abcdef",
      now: () => Date.parse("2026-11-03T03:00:00Z"), tzOffsetMinutes: () => 420, appVersion: "x",
      decode: async (_f, out, id) => { await writeFile(path.join(out, `${id}.mono.s16`), Buffer.alloc(4)); return { audio: "mono", durationMs: 1000 }; },
      enqueue: async () => undefined, progress: () => undefined,
    };
    expect((await runImport(d, { source: src, session: null, layout: "mixed" })).ok).toBe(true);
    expect(Buffer.compare(await readFile(src), bytes)).toBe(0);
    expect((await stat(src)).mtimeMs).toBe(mtime * 1000);
  });
});
