// D-171 "Import recording", review R3 I2: read an imported file WITHOUT decoding it — its length and channel count
// for the checks (over 2 hours is refused before anything is decoded), and its compressed packets for the decoder
// page, which decodes them a batch at a time (WebCodecs), so memory follows the batch, not the file.
//   WAV        header (PCM 8/16/24/32-bit or float), exact length from the data size; decoded in main.
//   MP3        frames walked one by one (an ID3v2 tag is skipped); length = frames × samples per frame.
//   OGG / OPUS Ogg pages → Opus packets (OpusHead first); length from the last granule; Vorbis is refused.
//   WEBM       webm.ts (Opus, as this app records); length from the last packet.
//   M4A        the MP4 boxes of the sound track: AAC decoder config (esds), sample sizes and offsets
//              (stsz / stsc / stco or co64), length from mdhd; a fragmented file (moof / trun) too.
// Pure TypeScript: no Node or Electron APIs, so it is tested with synthetic files.
import { MAX_RATE, MIN_RATE } from "../renderer/resample";
import { demuxWebmOpus } from "./webm";

/** Review R3-2 F1: only values a real recording has (anything else is a damaged header: "can't read"). */
const plausible = (rate: number, channels: number) =>
  Number.isInteger(rate) && rate >= MIN_RATE && rate <= MAX_RATE && Number.isInteger(channels) && channels >= 1 && channels <= 8;

export interface AudioPacket {
  timestampUs: number;
  data: Uint8Array;
}

export interface AudioTrack {
  /** WebCodecs codec string: "opus", "mp3", "mp4a.40.2". */
  codec: string;
  /** Decoder configuration (OpusHead, AAC AudioSpecificConfig), when the codec needs one. */
  codecPrivate: Uint8Array | null;
  sampleRate: number;
  channels: number;
  packets: AudioPacket[];
}

export interface WavInfo {
  format: "pcm" | "float";
  bits: number;
  sampleRate: number;
  channels: number;
  dataOffset: number;
  dataBytes: number;
}

export type Demuxed =
  | { ok: true; kind: "packets"; format: string; track: AudioTrack; durationMs: number }
  | { ok: true; kind: "wav"; format: "wav"; wav: WavInfo; durationMs: number }
  | { ok: false; message: string };

export type Inspected = { ok: true; format: string; channels: number; durationMs: number } | { ok: false; message: string };

export const UNREADABLE = "The app could not read this recording. Try another file, or export it again as MP3 or WAV.";
const NOT_OPUS = "This OGG file is not Opus audio. Export the recording as MP3 or WAV, then import it.";
const MP3_CHANGES = "This MP3 changes its format part-way (sample rate or channels), so the app cannot read all of it. Export the recording again as MP3 or WAV, then import it.";
const fail = (message = UNREADABLE): Demuxed => ({ ok: false, message });
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** A file name this app gives its stereo recordings: <date>-<time>-<hex>.webm or <session id>.webm. */
export function looksLikeAppRecording(name: string): boolean {
  return /^(\d{8}-\d{6}-[0-9a-f]{6}|[a-z0-9]{20,40})\.webm$/i.test(name);
}

// ---------------------------------------------------------------- WAV
function wavInfo(b: Uint8Array): WavInfo | null {
  if (b.length < 12 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WAVE") return null;
  const v = view(b);
  let off = 12;
  let fmt: Omit<WavInfo, "dataOffset" | "dataBytes"> | null = null;
  while (off + 8 <= b.length) {
    const id = ascii(b, off, 4);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt " && size >= 16) {
      let tag = v.getUint16(off + 8, true);
      const channels = v.getUint16(off + 10, true);
      const sampleRate = v.getUint32(off + 12, true);
      const blockAlign = v.getUint16(off + 20, true);
      const bits = v.getUint16(off + 22, true);
      if (tag === 0xfffe && size >= 26) tag = v.getUint16(off + 32, true); // WAVE_FORMAT_EXTENSIBLE: the subformat
      if (!plausible(sampleRate, channels) || blockAlign !== (channels * bits) / 8) return null;
      if (tag === 1 && [8, 16, 24, 32].includes(bits)) fmt = { format: "pcm", bits, sampleRate, channels };
      else if (tag === 3 && bits === 32) fmt = { format: "float", bits, sampleRate, channels };
      else return null;
    } else if (id === "data") {
      if (!fmt) return null;
      const dataBytes = Math.min(size, b.length - off - 8);
      return { ...fmt, dataOffset: off + 8, dataBytes };
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

// ---------------------------------------------------------------- MP3
const MP3_KBPS: Record<string, number[]> = {
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
};
const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3Frame(b: Uint8Array, at: number): { length: number; rate: number; samples: number; channels: number } | null {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[at + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layer = (b[at + 1] >> 1) & 3; // 1 = Layer III, 2 = Layer II
  if (version === 1 || (layer !== 1 && layer !== 2)) return null;
  const bitIndex = b[at + 2] >> 4;
  const rateIndex = (b[at + 2] >> 2) & 3;
  if (bitIndex === 0 || bitIndex === 15 || rateIndex === 3) return null;
  const padding = (b[at + 2] >> 1) & 1;
  const channels = b[at + 3] >> 6 === 3 ? 1 : 2;
  const rate = MP3_RATES[version][rateIndex];
  const kbps = layer === 2 ? MP3_KBPS["1-2"][bitIndex] : MP3_KBPS[version === 3 ? "1-3" : "2-3"][bitIndex];
  const samples = layer === 2 || version === 3 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * kbps * 1000) / rate) + padding;
  return length > 4 ? { length, rate, samples, channels } : null;
}

function demuxMp3(b: Uint8Array): Demuxed {
  let at = 0;
  if (b.length >= 10 && ascii(b, 0, 3) === "ID3") {
    at = 10 + ((b[6] & 0x7f) << 21) + ((b[7] & 0x7f) << 14) + ((b[8] & 0x7f) << 7) + (b[9] & 0x7f);
  }
  // Find the first frame (a little junk before it is common), then walk frame by frame.
  let first: ReturnType<typeof mp3Frame> = null;
  const limit = Math.min(b.length, at + 64 * 1024);
  while (at < limit && !(first = mp3Frame(b, at))) at++;
  if (!first) return fail();
  const packets: AudioPacket[] = [];
  let samples = 0;
  // A frame is trusted only when the next one starts right after it (or the file ends): no false sync in junk.
  const confirmed = (pos: number, f: NonNullable<ReturnType<typeof mp3Frame>>) => pos + f.length >= b.length || mp3Frame(b, pos + f.length) !== null;
  const same = (f: NonNullable<ReturnType<typeof mp3Frame>>) => f.rate === first!.rate && f.channels === first!.channels;
  while (at < b.length) {
    const f = mp3Frame(b, at);
    if (f && same(f)) {
      packets.push({ timestampUs: Math.round((samples / first.rate) * 1e6), data: b.subarray(at, Math.min(b.length, at + f.length)) });
      samples += f.samples;
      at += f.length;
      continue;
    }
    // Review R3-2 f4: never cut short silently. A real frame in another format → refused in plain words;
    // junk between frames → skipped to the next real frame; an ID3v1 tag (or nothing more) → the end.
    if (f && confirmed(at, f)) return fail(MP3_CHANGES);
    if (b.length - at <= 128 && ascii(b, at, 3) === "TAG") break;
    let next = at + 1;
    let g: ReturnType<typeof mp3Frame> = null;
    while (next < b.length && !((g = mp3Frame(b, next)) && confirmed(next, g))) next++;
    if (next >= b.length) break;
    at = next;
  }
  if (!packets.length) return fail();
  return {
    ok: true, kind: "packets", format: "mp3",
    track: { codec: "mp3", codecPrivate: null, sampleRate: first.rate, channels: first.channels, packets },
    durationMs: Math.round((samples / first.rate) * 1000),
  };
}

// ---------------------------------------------------------------- OGG Opus
/** Samples (at 48 kHz) in one Opus packet, from its TOC byte (RFC 6716 §3.1). */
function opusPacketSamples(p: Uint8Array): number {
  if (!p.length) return 0;
  const config = p[0] >> 3;
  const frame = config < 12 ? [480, 960, 1920, 2880][config & 3] : config < 16 ? [480, 960][config & 1] : [120, 240, 480, 960][config & 3];
  const code = p[0] & 3;
  const frames = code === 0 ? 1 : code === 3 ? (p.length > 1 ? p[1] & 0x3f : 0) : 2;
  return frame * frames;
}

function demuxOgg(b: Uint8Array): Demuxed {
  const v = view(b);
  const packets: Uint8Array[] = [];
  let pending: Uint8Array[] = [];
  let lastGranule = -1;
  let at = 0;
  while (at + 27 <= b.length && ascii(b, at, 4) === "OggS") {
    const segments = b[at + 26];
    const granule = Number(v.getBigInt64(at + 6, true));
    let data = at + 27 + segments;
    for (let i = 0; i < segments; i++) {
      const len = b[at + 27 + i];
      pending.push(b.subarray(data, data + len));
      data += len;
      if (len < 255) {
        let joined = pending[0];
        if (pending.length > 1) {
          joined = new Uint8Array(pending.reduce((n, x) => n + x.length, 0));
          let o = 0;
          for (const x of pending) { joined.set(x, o); o += x.length; }
        }
        packets.push(joined);
        pending = [];
      }
    }
    if (granule >= 0) lastGranule = granule;
    at = data;
  }
  if (!packets.length) return fail();
  if (ascii(packets[0], 0, 8) !== "OpusHead") return fail(NOT_OPUS);
  const head = packets[0];
  const channels = head[9];
  if (!plausible(48000, channels)) return fail();
  const preSkip = head[10] | (head[11] << 8);
  let t = 0;
  const out: AudioPacket[] = packets.slice(2).map((data) => {
    const p = { timestampUs: Math.round((t / 48000) * 1e6), data };
    t += opusPacketSamples(data);
    return p;
  });
  if (!out.length) return fail();
  // Review R3-2 f3: the larger of the header's length and the packets' (a damaged granule cannot shorten it).
  const samples = Math.max(lastGranule > preSkip ? lastGranule - preSkip : 0, t);
  return {
    ok: true, kind: "packets", format: "ogg",
    track: { codec: "opus", codecPrivate: head, sampleRate: 48000, channels, packets: out },
    durationMs: Math.round((samples / 48000) * 1000),
  };
}

// ---------------------------------------------------------------- WebM (Opus)
function demuxWebm(b: Uint8Array): Demuxed {
  try {
    const t = demuxWebmOpus(b);
    if (!t.packets.length || !plausible(t.sampleRate || 48000, t.channels || 1)) return fail();
    const last = t.packets[t.packets.length - 1];
    return {
      ok: true, kind: "packets", format: "webm",
      track: { codec: "opus", codecPrivate: t.codecPrivate, sampleRate: t.sampleRate || 48000, channels: t.channels || 1, packets: t.packets },
      durationMs: Math.round(last.timestampUs / 1000 + opusPacketSamples(last.data) / 48),
    };
  } catch {
    return fail();
  }
}

// ---------------------------------------------------------------- M4A / MP4 (AAC)
interface Box { type: string; start: number; end: number; body: number }

function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const v = view(b);
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = v.getUint32(at);
    let body = at + 8;
    if (size === 1 && at + 16 <= to) {
      size = Number(v.getBigUint64(at + 8));
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < 8 || at + size > to) break;
    out.push({ type: ascii(b, at + 4, 4), start: at, end: at + size, body });
    at += size;
  }
  return out;
}
const child = (b: Uint8Array, parent: Box, type: string, skip = 0) => boxes(b, parent.body + skip, parent.end).find((x) => x.type === type);

/** The AudioSpecificConfig inside an esds box (descriptor tags 0x03 → 0x04 → 0x05). */
function esdsConfig(b: Uint8Array, esds: Box): Uint8Array | null {
  let at = esds.body + 4;
  const readLen = () => {
    let n = 0;
    for (let i = 0; i < 4 && at < esds.end; i++) {
      const c = b[at++];
      n = (n << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return n;
  };
  while (at < esds.end) {
    const tag = b[at++];
    const len = readLen();
    if (tag === 0x03) { at += 3; continue; } // ES_ID + flags, then the nested descriptors
    if (tag === 0x04) { at += 13; continue; } // objectType … avgBitrate, then the DecoderSpecificInfo
    if (tag === 0x05) return b.slice(at, at + len);
    at += len;
  }
  return null;
}

function mp4Packets(b: Uint8Array, top: Box[], stbl: Box, rate: number): { packets: AudioPacket[]; fragmented: boolean } | null {
  const v = view(b);
  const stsz = child(b, stbl, "stsz");
  const stsc = child(b, stbl, "stsc");
  const stco = child(b, stbl, "stco") ?? child(b, stbl, "co64");
  const sizes: number[] = [];
  if (stsz) {
    const fixed = v.getUint32(stsz.body + 4);
    const count = v.getUint32(stsz.body + 8);
    // Review R3-2 f2: a count the file cannot hold is a damaged table — refused before anything is allocated.
    if (fixed ? count > b.length / fixed : 12 + 4 * count > stsz.end - stsz.body) return null;
    for (let i = 0; i < count; i++) sizes.push(fixed || v.getUint32(stsz.body + 12 + 4 * i));
  }
  const packets: AudioPacket[] = [];
  const add = (at: number, size: number) => {
    packets.push({ timestampUs: Math.round(((packets.length * 1024) / rate) * 1e6), data: b.subarray(at, at + size) });
  };
  if (sizes.length && stsc && stco) {
    // The sample tables: chunk offsets, samples per chunk (runs), sample sizes.
    const chunks = v.getUint32(stco.body + 4);
    const stscCount = v.getUint32(stsc.body + 4);
    if (8 + chunks * (stco.type === "co64" ? 8 : 4) > stco.end - stco.body || 8 + stscCount * 12 > stsc.end - stsc.body) return null;
    const offsets = Array.from({ length: chunks }, (_, i) => (stco.type === "co64" ? Number(v.getBigUint64(stco.body + 8 + 8 * i)) : v.getUint32(stco.body + 8 + 4 * i)));
    const runs = Array.from({ length: stscCount }, (_, i) => ({ first: v.getUint32(stsc.body + 8 + 12 * i), per: v.getUint32(stsc.body + 12 + 12 * i) }));
    let s = 0;
    let r = 0;
    for (let c = 0; c < chunks && s < sizes.length; c++) {
      while (r + 1 < runs.length && runs[r + 1].first <= c + 1) r++;
      let at = offsets[c];
      for (let k = 0; k < (runs[r]?.per ?? 0) && s < sizes.length; k++, s++) {
        if (at + sizes[s] > b.length) return { packets, fragmented: false };
        add(at, sizes[s]);
        at += sizes[s];
      }
    }
    return { packets, fragmented: false };
  }
  // A fragmented file (moof / traf / trun): each fragment says where its samples are.
  for (const moof of top.filter((x) => x.type === "moof")) {
    for (const traf of boxes(b, moof.body, moof.end).filter((x) => x.type === "traf")) {
      const tfhd = child(b, traf, "tfhd");
      if (!tfhd) continue;
      const tf = v.getUint32(tfhd.body) & 0xffffff;
      let p = tfhd.body + 8;
      const base = tf & 0x1 ? Number(v.getBigUint64(p)) : moof.start;
      if (tf & 0x1) p += 8;
      if (tf & 0x2) p += 4;
      if (tf & 0x8) p += 4;
      const defaultSize = tf & 0x10 ? v.getUint32(p) : 0;
      for (const trun of boxes(b, traf.body, traf.end).filter((x) => x.type === "trun")) {
        const fl = v.getUint32(trun.body) & 0xffffff;
        const count = v.getUint32(trun.body + 4);
        let q = trun.body + 8;
        let at = base + (fl & 0x1 ? v.getInt32(q) : 0);
        if (fl & 0x1) q += 4;
        if (fl & 0x4) q += 4;
        for (let i = 0; i < count; i++) {
          if (fl & 0x100) q += 4;
          const size = fl & 0x200 ? v.getUint32(q) : defaultSize;
          if (fl & 0x200) q += 4;
          if (fl & 0x400) q += 4;
          if (fl & 0x800) q += 4;
          if (!size || at + size > b.length) break;
          add(at, size);
          at += size;
        }
      }
    }
  }
  return { packets, fragmented: true };
}

function demuxMp4(b: Uint8Array): Demuxed {
  const v = view(b);
  const top = boxes(b, 0, b.length);
  const moov = top.find((x) => x.type === "moov");
  if (!moov) return fail();
  for (const trak of boxes(b, moov.body, moov.end).filter((x) => x.type === "trak")) {
    const mdia = child(b, trak, "mdia");
    const hdlr = mdia && child(b, mdia, "hdlr");
    if (!mdia || !hdlr || ascii(b, hdlr.body + 8, 4) !== "soun") continue;
    const mdhd = child(b, mdia, "mdhd");
    const minf = child(b, mdia, "minf");
    const stbl = minf && child(b, minf, "stbl");
    const stsd = stbl && child(b, stbl, "stsd");
    const entry = stsd && boxes(b, stsd.body + 8, stsd.end)[0];
    if (!mdhd || !stbl || !entry || entry.type !== "mp4a") return fail();
    const channels = v.getUint16(entry.body + 16);
    const sampleRate = v.getUint32(entry.body + 24) >>> 16;
    const esds = child(b, entry, "esds", 28);
    const config = esds ? esdsConfig(b, esds) : null;
    if (!config) return fail();
    const version = b[mdhd.body];
    const timescale = version === 1 ? v.getUint32(mdhd.body + 20) : v.getUint32(mdhd.body + 12);
    const duration = version === 1 ? Number(v.getBigUint64(mdhd.body + 24)) : v.getUint32(mdhd.body + 16);
    const rate = sampleRate || timescale;
    if (!plausible(rate, channels || 2)) return fail();
    const parsed = mp4Packets(b, top, stbl, rate);
    if (!parsed || !parsed.packets.length) return fail();
    const { packets, fragmented } = parsed;
    const counted = Math.round(((packets.length * 1024) / rate) * 1000);
    // A fragmented file's mdhd holds no real length (MediaRecorder writes a placeholder): count the samples.
    // Review R3-2 f3: otherwise the larger of mdhd's length and the counted one.
    const durationMs = !fragmented && duration > 0 && timescale > 0 ? Math.max(counted, Math.round((duration / timescale) * 1000)) : counted;
    return {
      ok: true, kind: "packets", format: "m4a",
      track: { codec: "mp4a.40.2", codecPrivate: config, sampleRate: rate, channels: channels || 2, packets },
      durationMs,
    };
  }
  return fail();
}

// ---------------------------------------------------------------- entry points
export function demuxAudio(bytes: Uint8Array, ext: string): Demuxed {
  try {
    switch (ext.toLowerCase()) {
      case ".wav": {
        const w = wavInfo(bytes);
        if (!w) return fail();
        const frameBytes = (w.bits / 8) * w.channels;
        return { ok: true, kind: "wav", format: "wav", wav: w, durationMs: Math.round((w.dataBytes / frameBytes / w.sampleRate) * 1000) };
      }
      case ".mp3": return demuxMp3(bytes);
      case ".ogg":
      case ".opus": return demuxOgg(bytes);
      case ".webm": return demuxWebm(bytes);
      case ".m4a": return demuxMp4(bytes);
      default: return fail();
    }
  } catch {
    return fail();
  }
}

export function inspectAudio(bytes: Uint8Array, ext: string): Inspected {
  const d = demuxAudio(bytes, ext);
  if (!d.ok) return d;
  if (!(d.durationMs > 0)) return { ok: false, message: UNREADABLE };
  return { ok: true, format: d.format, channels: d.kind === "wav" ? d.wav.channels : d.track.channels, durationMs: d.durationMs };
}
