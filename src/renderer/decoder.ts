// The hidden decoder page: turns batches of Opus packets (from main, read out of <id>.left/.right.webm) into
// 16 kHz mono samples with WebCodecs' AudioDecoder, and sends them back batch by batch. Nothing is played,
// nothing leaves the laptop, and the page never sees a file path. See src/main/decoderClient.ts.
// D-171: it also decodes a whole imported file (MP3, M4A, WAV, WebM / OGG Opus — whatever Chromium reads) at
// 16 kHz with decodeAudioData, keeps it until main has read its channels block by block, then frees it.
import type { DecoderBridge } from "../main/decoderPreload";
import type { DecoderReply, DecoderRequest } from "../main/decoderClient";
import { Downsampler } from "./downsample";

declare global {
  interface Window {
    decoderBridge: DecoderBridge;
  }
}

const OUT_RATE = 16000;

interface Session {
  decoder: AudioDecoder;
  down: Downsampler | null;
  out: Float32Array[];
  error: string | null;
}

const sessions = new Map<number, Session>();
/** D-171: decoded imported files, by session id, until main closes them. */
const files = new Map<number, AudioBuffer>();

/** Two channels carrying the same sound: a mono recording saved as stereo (its difference is ~silent). */
function sameSound(b: AudioBuffer): boolean {
  if (b.numberOfChannels < 2) return false;
  const l = b.getChannelData(0);
  const r = b.getChannelData(1);
  let diff = 0;
  let total = 0;
  for (let i = 0; i < l.length; i += 4) {
    const d = l[i] - r[i];
    diff += d * d;
    total += l[i] * l[i] + r[i] * r[i];
  }
  return total === 0 || diff / total < 0.01;
}

async function handleFile(req: DecoderRequest): Promise<DecoderReply | null> {
  if (req.kind === "loadFile") {
    const ctx = new OfflineAudioContext(1, 1, OUT_RATE);
    const bytes = req.bytes.byteOffset === 0 && req.bytes.byteLength === req.bytes.buffer.byteLength ? req.bytes.buffer : req.bytes.slice().buffer;
    const buf = await ctx.decodeAudioData(bytes as ArrayBuffer);
    files.set(req.sid, buf);
    return { sid: req.sid, ok: true, info: { channels: buf.numberOfChannels, frames: buf.length, similar: sameSound(buf) } };
  }
  const buf = files.get(req.sid);
  if (req.kind === "readFile") {
    if (!buf) return { sid: req.sid, ok: false, error: "no_session" };
    const end = Math.min(buf.length, req.start + req.count);
    if (req.channel >= 0) return { sid: req.sid, ok: true, pcm: buf.getChannelData(Math.min(req.channel, buf.numberOfChannels - 1)).slice(req.start, end) };
    const out = new Float32Array(Math.max(0, end - req.start));
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i] += data[req.start + i] / buf.numberOfChannels;
    }
    return { sid: req.sid, ok: true, pcm: out };
  }
  if (req.kind === "close" && buf) {
    files.delete(req.sid);
    return { sid: req.sid, ok: true };
  }
  return null;
}
const bridge = () => window.decoderBridge;

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** One decoded block → mono float32 → 16 kHz, appended to the session's output. */
function take(s: Session, data: AudioData): void {
  try {
    const frames = data.numberOfFrames;
    const channels = data.numberOfChannels;
    const mono = new Float32Array(frames);
    const plane = new Float32Array(frames);
    for (let c = 0; c < channels; c++) {
      data.copyTo(plane, { planeIndex: c, format: "f32-planar" });
      for (let i = 0; i < frames; i++) mono[i] += plane[i] / channels;
    }
    if (!s.down) s.down = new Downsampler(data.sampleRate, OUT_RATE);
    s.out.push(s.down.push(mono));
  } catch {
    s.error = "convert_error";
  } finally {
    data.close();
  }
}

async function handle(req: DecoderRequest): Promise<DecoderReply> {
  const file = await handleFile(req);
  if (file) return file;
  if (req.kind === "loadFile" || req.kind === "readFile") return { sid: req.sid, ok: false, error: "no_session" };
  if (req.kind === "open") {
    if (typeof AudioDecoder === "undefined") return { sid: req.sid, ok: false, error: "no_webcodecs" };
    const s: Session = { decoder: null as unknown as AudioDecoder, down: null, out: [], error: null };
    s.decoder = new AudioDecoder({ output: (d) => take(s, d), error: () => void (s.error = "decode_error") });
    s.decoder.configure({
      codec: "opus",
      sampleRate: req.sampleRate,
      numberOfChannels: req.channels,
      ...(req.codecPrivate ? { description: req.codecPrivate } : {}),
    });
    sessions.set(req.sid, s);
    return { sid: req.sid, ok: true };
  }
  const s = sessions.get(req.sid);
  if (!s) return { sid: req.sid, ok: false, error: "no_session" };
  if (req.kind === "feed") {
    for (const p of req.packets) s.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: p.t, data: p.data }));
    await s.decoder.flush();
    if (s.error) return { sid: req.sid, ok: false, error: s.error };
    const pcm = concat(s.out);
    s.out = [];
    return { sid: req.sid, ok: true, pcm };
  }
  // close: the last samples of the filter, then free the decoder.
  sessions.delete(req.sid);
  const tail = s.down ? s.down.flush() : new Float32Array(0);
  try {
    s.decoder.close();
  } catch {
    // already closed after an error
  }
  return { sid: req.sid, ok: true, pcm: concat([...s.out, tail]) };
}

bridge().onRequest((req) => {
  handle(req)
    .then((r) => bridge().reply(r))
    .catch(() => bridge().reply({ sid: req.sid, ok: false, error: "decode_error" }));
});
bridge().ready();
