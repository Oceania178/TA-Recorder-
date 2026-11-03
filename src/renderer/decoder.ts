// The hidden decoder page: turns batches of compressed packets (from main: Opus out of a live call's
// <id>.left/.right.webm, or — D-171 — Opus, MP3 or AAC out of an imported file) into 16 kHz samples with
// WebCodecs' AudioDecoder, and sends them back batch by batch. Nothing is played, nothing leaves the laptop, the
// page never sees a file path, and it never holds a whole file (review R3 I2). See src/main/decoderClient.ts.
//   mono (a live call's track; a mixed import): all channels averaged;
//   stereo (an import the TA says is TA Call Recorder stereo): channel 0 in `pcm`, channel 1 in `pcm2`.
import type { DecoderBridge } from "../main/decoderPreload";
import type { DecoderReply, DecoderRequest } from "../main/decoderClient";
import { Downsampler } from "./downsample";
import { StreamResampler } from "./resample";

declare global {
  interface Window {
    decoderBridge: DecoderBridge;
  }
}

const OUT_RATE = 16000;

interface Rate {
  push(x: Float32Array): Float32Array;
  flush(): Float32Array;
}

interface Session {
  decoder: AudioDecoder;
  stereo: boolean;
  /** One per output channel (1 or 2), created at the first decoded block (its real sample rate). */
  rates: Rate[] | null;
  out: Float32Array[][];
  error: string | null;
}

const sessions = new Map<number, Session>();
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

/** 48 kHz (a live call) keeps the exact integer filter; any other rate (44.1, 22.05, 8 kHz…) the general one. */
const rateFor = (sampleRate: number): Rate =>
  sampleRate % OUT_RATE === 0 ? new Downsampler(sampleRate, OUT_RATE) : new StreamResampler(sampleRate, OUT_RATE);

/** One decoded block → float32 channel(s) → 16 kHz, appended to the session's output. */
function take(s: Session, data: AudioData): void {
  try {
    const frames = data.numberOfFrames;
    const channels = data.numberOfChannels;
    const plane = new Float32Array(frames);
    const outs = s.stereo ? [new Float32Array(frames), new Float32Array(frames)] : [new Float32Array(frames)];
    for (let c = 0; c < channels; c++) {
      data.copyTo(plane, { planeIndex: c, format: "f32-planar" });
      if (s.stereo) {
        if (c < 2) outs[c].set(plane);
        if (channels === 1) outs[1].set(plane);
      } else {
        for (let i = 0; i < frames; i++) outs[0][i] += plane[i] / channels;
      }
    }
    if (!s.rates) s.rates = outs.map(() => rateFor(data.sampleRate));
    outs.forEach((x, i) => s.out[i].push(s.rates![i].push(x)));
  } catch {
    s.error = "convert_error";
  } finally {
    data.close();
  }
}

function drain(s: Session, sid: number, tail = false): DecoderReply {
  const parts = s.out.map((chunks, i) => concat(tail && s.rates ? [...chunks, s.rates[i].flush()] : chunks));
  s.out = s.out.map(() => []);
  return { sid, ok: true, pcm: parts[0], ...(s.stereo ? { pcm2: parts[1] } : {}) };
}

async function handle(req: DecoderRequest): Promise<DecoderReply> {
  if (req.kind === "open") {
    if (typeof AudioDecoder === "undefined") return { sid: req.sid, ok: false, error: "no_webcodecs" };
    const stereo = req.stereo === true;
    const s: Session = { decoder: null as unknown as AudioDecoder, stereo, rates: null, out: stereo ? [[], []] : [[]], error: null };
    s.decoder = new AudioDecoder({ output: (d) => take(s, d), error: () => void (s.error = "decode_error") });
    s.decoder.configure({
      codec: req.codec ?? "opus",
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
    return drain(s, req.sid);
  }
  // close: the last samples of the filter, then free the decoder.
  sessions.delete(req.sid);
  try {
    s.decoder.close();
  } catch {
    // already closed after an error
  }
  return drain(s, req.sid, true);
}

bridge().onRequest((req) => {
  handle(req)
    .then((r) => bridge().reply(r))
    .catch(() => bridge().reply({ sid: req.sid, ok: false, error: "decode_error" }));
});
bridge().ready();
