// D-171 "Import recording" — fix round 2 (review R3-2): F1 implausible header values are refused at the pick (a
// 4 GHz WAV froze main while the resampler was built); f2 M4A tables bounded by the file size; f3 the larger of the
// header length and the parsed length, and a hard stop at 2 h while decoding; f4 an MP3 that changes format is
// refused, junk between frames is skipped; f5 a live call that ended before Import is said to be saved and sent.
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectAudio, UNREADABLE } from "../../src/main/audioDemux";
import { DecoderClient, decodeFileToPcm, type DecoderReply, type DecoderRequest } from "../../src/main/decoderClient";
import { IMPORT_MESSAGES } from "../../src/main/importFlow";
import { liveEndedBeforeImport, LIVE_ENDED_MESSAGE } from "../../src/renderer/importText";
import { StreamResampler } from "../../src/renderer/resample";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "tcr-fix2-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function wavHeader(o: { rate: number; channels: number; bits?: number; blockAlign?: number; dataBytes?: number }): Buffer {
  const bits = o.bits ?? 16;
  const dataBytes = o.dataBytes ?? 4000;
  const h = Buffer.alloc(44 + dataBytes);
  h.write("RIFF", 0); h.writeUInt32LE(36 + dataBytes, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(o.channels, 22); h.writeUInt32LE(o.rate >>> 0, 24);
  h.writeUInt32LE(((o.rate * o.channels * bits) / 8) >>> 0, 28); h.writeUInt16LE(o.blockAlign ?? (o.channels * bits) / 8, 32); h.writeUInt16LE(bits, 34);
  h.write("data", 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

describe("F1: implausible header values are refused at the pick, quickly", () => {
  it("WAV sample rates of 400 MHz and 4 GHz, 0 or 9+ channels, a wrong block size: 'can't read'", () => {
    for (const bad of [
      wavHeader({ rate: 400_000_000, channels: 1 }),
      wavHeader({ rate: 4_000_000_000, channels: 1 }),
      wavHeader({ rate: 3_999, channels: 1 }),
      wavHeader({ rate: 16_000, channels: 9 }),
      wavHeader({ rate: 16_000, channels: 2, blockAlign: 3 }),
    ]) {
      const t0 = Date.now();
      expect(inspectAudio(bad, ".wav")).toEqual({ ok: false, message: UNREADABLE });
      expect(Date.now() - t0).toBeLessThan(200);
    }
    expect(inspectAudio(wavHeader({ rate: 192_000, channels: 8 }), ".wav")).toMatchObject({ ok: true, channels: 8 });
    expect(inspectAudio(wavHeader({ rate: 8_000, channels: 1 }), ".wav")).toMatchObject({ ok: true, channels: 1 });
  });

  it("the resampler refuses a rate no header may give, and its filter stays small", () => {
    const t0 = Date.now();
    expect(() => new StreamResampler(4_000_000_000)).toThrow();
    expect(() => new StreamResampler(400_000_000)).toThrow();
    expect(() => new StreamResampler(1_000)).toThrow();
    new StreamResampler(192_000);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("an Opus head with no or too many channels is refused", () => {
    const ogg = (channels: number) => {
      const head = Buffer.alloc(19);
      head.write("OpusHead", 0); head[8] = 1; head[9] = channels; head.writeUInt32LE(48000, 12);
      return oggFile([head, Buffer.from("OpusTags\0\0\0\0\0\0\0\0"), Buffer.from([0xfc, 1, 2])], 312 + 960);
    };
    expect(inspectAudio(ogg(0), ".ogg")).toEqual({ ok: false, message: UNREADABLE });
    expect(inspectAudio(ogg(9), ".ogg")).toEqual({ ok: false, message: UNREADABLE });
    expect(inspectAudio(ogg(2), ".ogg")).toMatchObject({ ok: true, channels: 2 });
  });
});

// ---------------------------------------------------------------- Ogg / MP4 builders
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
/** head, tags, then audio packets; every page claims `granule` (a damaged or lying length). */
function oggFile(packets: Buffer[], granule: number): Buffer {
  const pages = [oggPage([packets[0]], 0, 0, 2), oggPage([packets[1]], 0, 1, 0)];
  for (let i = 2; i < packets.length; i += 50) pages.push(oggPage(packets.slice(i, i + 50), granule, pages.length, 0));
  return Buffer.concat(pages);
}
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0); h.write(type, 4);
  return Buffer.concat([h, body]);
};
const u32 = (...v: number[]) => { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4)); return b; };
const u16 = (...v: number[]) => { const b = Buffer.alloc(2 * v.length); v.forEach((x, i) => b.writeUInt16BE(x, i * 2)); return b; };
function m4a(o: { frames: number; mdhdFrames: number; stsz?: Buffer }): Buffer {
  const esds = box("esds", u32(0), Buffer.from([3, 25, 0, 1, 0, 4, 17, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 2]), Buffer.from([0x12, 0x10]), Buffer.from([6, 1, 2]));
  const mp4a = box("mp4a", Buffer.alloc(6), u16(1), Buffer.alloc(8), u16(2, 16, 0, 0), u32(44100 * 65536), esds);
  const stsz = o.stsz ?? box("stsz", u32(0, 10, o.frames));
  const build = (offset: number) => {
    const stbl = box("stbl", box("stsd", u32(0, 1), mp4a), box("stts", u32(0, 1, o.frames, 1024)), box("stsc", u32(0, 1, 1, o.frames, 1)), stsz, box("stco", u32(0, 1, offset)));
    const hdlr = box("hdlr", u32(0, 0), Buffer.from("soun"), u32(0, 0, 0), Buffer.from([0]));
    return Buffer.concat([box("ftyp", Buffer.from("M4A "), u32(0)), box("moov", box("trak", box("mdia", box("mdhd", u32(0, 0, 0, 44100, o.mdhdFrames * 1024), u16(0, 0)), hdlr, box("minf", stbl))))]);
  };
  const head = build(build(0).length + 8);
  return Buffer.concat([head, box("mdat", Buffer.alloc(o.frames * 10, 5))]);
}

describe("f2: M4A tables are bounded by the file size before anything is allocated", () => {
  it("a sample count of 4.29 G (fixed size) or more listed sizes than the box holds: refused, quickly", () => {
    for (const stsz of [box("stsz", u32(0, 10, 0xffffffff)), box("stsz", u32(0, 0, 0xfffffff0), u32(10, 10))]) {
      const t0 = Date.now();
      expect(inspectAudio(m4a({ frames: 2, mdhdFrames: 2, stsz }), ".m4a")).toEqual({ ok: false, message: UNREADABLE });
      expect(Date.now() - t0).toBeLessThan(300);
    }
  });
});

describe("f3: the length is the larger of the header's and the one parsed from the packets", () => {
  it("an M4A whose mdhd understates its length", () => {
    expect(inspectAudio(m4a({ frames: 430, mdhdFrames: 4 }), ".m4a")).toMatchObject({ ok: true, durationMs: Math.round((430 * 1024 * 1000) / 44100) });
  });

  it("an Ogg whose granule understates its length", () => {
    const head = Buffer.alloc(19);
    head.write("OpusHead", 0); head[8] = 1; head[9] = 2; head.writeUInt16LE(312, 10); head.writeUInt32LE(48000, 12);
    const pkts = Array.from({ length: 250 }, () => Buffer.from([0xfc, 1, 2, 3]));
    expect(inspectAudio(oggFile([head, Buffer.from("OpusTags\0\0\0\0\0\0\0\0"), ...pkts], 312 + 960), ".ogg")).toMatchObject({ ok: true, durationMs: 5000 });
  });

  it("decoding stops at 2 hours of output whatever the header said (a hard stop)", async () => {
    let listener: (r: DecoderReply) => void = () => undefined;
    // A page that answers every batch with 1 hour of samples: the third batch passes 2 hours.
    const transport = {
      onReply: (l: (r: DecoderReply) => void) => { listener = l; },
      send: (req: DecoderRequest) => queueMicrotask(() => listener({ sid: req.sid, ok: true, pcm: req.kind === "feed" ? new Float32Array(16_000 * 3600) : undefined })),
    };
    const head = Buffer.alloc(19);
    head.write("OpusHead", 0); head[8] = 1; head[9] = 1; head.writeUInt16LE(312, 10); head.writeUInt32LE(48000, 12);
    const file = oggFile([head, Buffer.from("OpusTags\0\0\0\0\0\0\0\0"), ...Array.from({ length: 30 }, () => Buffer.from([0xf8, 1]))], 312 + 960 * 30);
    await expect(decodeFileToPcm(new DecoderClient(transport, { batchPackets: 10 }), file, ".ogg", dir, "long-000001", { layout: "mixed" })).rejects.toThrow(IMPORT_MESSAGES.tooLong);
  });
});

/** MP3 frames (MPEG-1 Layer III, 128 kbps): 44.1 kHz (417 bytes) or 48 kHz (384 bytes). */
const frame = (rate: 44100 | 48000, mono = false) => {
  const f = Buffer.alloc(rate === 44100 ? 417 : 384);
  f.set([0xff, 0xfb, rate === 44100 ? 0x90 : 0x94, mono ? 0xc4 : 0x64]);
  return f;
};

describe("f4: an MP3 is never cut short silently", () => {
  it("junk between frames is skipped (resync); every frame counts", () => {
    const file = Buffer.concat([...Array.from({ length: 50 }, () => frame(44100)), Buffer.from("junk-junk-junk"), ...Array.from({ length: 50 }, () => frame(44100))]);
    expect(inspectAudio(file, ".mp3")).toMatchObject({ ok: true, durationMs: Math.round((100 * 1152 * 1000) / 44100) });
  });

  it("a change of sample rate or of mono / stereo part-way is refused with a clear message", () => {
    const msg = "This MP3 changes its format part-way (sample rate or channels), so the app cannot read all of it. Export the recording again as MP3 or WAV, then import it.";
    expect(inspectAudio(Buffer.concat([...Array.from({ length: 20 }, () => frame(44100)), ...Array.from({ length: 20 }, () => frame(48000))]), ".mp3")).toEqual({ ok: false, message: msg });
    expect(inspectAudio(Buffer.concat([...Array.from({ length: 20 }, () => frame(44100)), ...Array.from({ length: 20 }, () => frame(44100, true))]), ".mp3")).toEqual({ ok: false, message: msg });
  });

  it("an ID3v1 tag at the end is not audio and not an error", () => {
    const tag = Buffer.alloc(128);
    tag.write("TAG", 0);
    expect(inspectAudio(Buffer.concat([...Array.from({ length: 10 }, () => frame(44100)), tag]), ".mp3")).toMatchObject({ ok: true });
  });
});

describe("f5: the live call ended (and was saved) before Import was pressed", () => {
  it("the dialog says it is saved and sent as usual, not 'press Call & record again'", async () => {
    expect(LIVE_ENDED_MESSAGE).toBe("The live call ended before you pressed Import. It was saved and is transcribed and sent to Solace as usual. Nothing was imported.");
    expect(liveEndedBeforeImport({ forLive: true }, false)).toBe(true);
    expect(liveEndedBeforeImport({ forLive: true }, true)).toBe(false);
    expect(liveEndedBeforeImport({ forLive: false }, false)).toBe(false);
    const src = await readFile(path.join(__dirname, "..", "..", "src", "renderer", "importUi.ts"), "utf8");
    expect(src).toMatch(/liveEndedBeforeImport\(p, host\.liveLinked\(\)\)/);
  });
});
