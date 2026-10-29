// core/vad.ts — find the stretches of speech in ONE channel (option B, D-15; spec §5.1), so each one can
// be transcribed on its own with known times. Energy-based, offline (the whole call is known after Stop):
//
// 1. Cut the signal into short frames (20 ms) and measure each frame's loudness (RMS, in dBFS).
// 2. Track the background level ("noise floor"): it starts at the quietest tenth of the call and follows
//    the background slowly, falling fast when it gets quieter. A frame is speech when it is clearly
//    louder than the floor (thresholdDb) and not near-silent in absolute terms (minSpeechDb). The floor is
//    capped (maxFloorDb) so a call that is speech from end to end is still found.
// 3. Hangover: a region stays open for a moment after the last loud frame, so word endings are kept.
// 4. Drop clicks (shorter than minSpeechMs), merge regions with gaps under ~0.6 s, pad the edges, and cut
//    regions longer than maxSegmentMs at their quietest moment.
// Output: whole milliseconds from the start of the channel, in order.
import type { SpeechSegment } from "./types";

export interface VadOptions {
  frameMs: number;
  /** How far above the noise floor a frame must be to count as speech. */
  thresholdDb: number;
  /** Frames quieter than this are never speech (digital silence, line hiss). */
  minSpeechDb: number;
  /** The floor never rises above this, so speech that never stops is still found. */
  maxFloorDb: number;
  /** Keep a region open this long after its last loud frame. */
  hangoverMs: number;
  /** A region with less loud audio than this is a click, not speech. */
  minSpeechMs: number;
  /** Regions closer than this are one segment (short pauses inside a sentence). */
  mergeGapMs: number;
  /** Extra audio kept before and after each segment. */
  padMs: number;
  /** Longest segment sent to Gemini in one request. */
  maxSegmentMs: number;
}

export const DEFAULT_VAD: VadOptions = {
  frameMs: 20,
  thresholdDb: 9,
  minSpeechDb: -50,
  maxFloorDb: -35,
  hangoverMs: 200,
  minSpeechMs: 120,
  mergeGapMs: 600,
  padMs: 150,
  maxSegmentMs: 30_000,
};

const FLOOR_MIN_DB = -90;
const FLOOR_FALL = 0.3;
const FLOOR_RISE = 0.01;

/** Per-frame loudness in dBFS. */
function frameLevels(pcm: Float32Array, frameLen: number): Float64Array {
  const n = Math.ceil(pcm.length / frameLen);
  const out = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const a = f * frameLen;
    const b = Math.min(pcm.length, a + frameLen);
    let sum = 0;
    for (let i = a; i < b; i++) sum += pcm[i] * pcm[i];
    const rms = Math.sqrt(sum / Math.max(1, b - a));
    out[f] = 20 * Math.log10(rms + 1e-10);
  }
  return out;
}

function percentile(values: Float64Array, p: number): number {
  const sorted = Array.from(values).sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

interface Region { start: number; end: number; voicedMs: number }

export function detectSpeech(pcm: Float32Array, sampleRate: number, options: Partial<VadOptions> = {}): SpeechSegment[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError("sampleRate must be a positive number");
  const o = { ...DEFAULT_VAD, ...options };
  if (pcm.length === 0) return [];
  const durationMs = (pcm.length / sampleRate) * 1000;
  const frameLen = Math.max(1, Math.round((o.frameMs / 1000) * sampleRate));
  const frameMs = (frameLen / sampleRate) * 1000;
  const levels = frameLevels(pcm, frameLen);

  // 1–3: classify frames against an adaptive floor, with hangover.
  const clampFloor = (x: number) => Math.min(o.maxFloorDb, Math.max(FLOOR_MIN_DB, x));
  let floor = clampFloor(percentile(levels, 0.1));
  const regions: Region[] = [];
  let open: { start: number; lastVoiced: number; voicedMs: number } | null = null;
  const close = (r: { start: number; lastVoiced: number; voicedMs: number }) =>
    regions.push({ start: r.start, end: Math.min(durationMs, r.lastVoiced + o.hangoverMs), voicedMs: r.voicedMs });

  for (let f = 0; f < levels.length; f++) {
    const db = levels[f];
    const t0 = f * frameMs;
    const t1 = Math.min(durationMs, t0 + frameMs);
    const voiced = db > Math.max(floor + o.thresholdDb, o.minSpeechDb);
    if (db < floor) floor = clampFloor(floor + (db - floor) * FLOOR_FALL);
    else if (!voiced) floor = clampFloor(floor + (db - floor) * FLOOR_RISE);

    if (voiced) {
      if (!open) open = { start: t0, lastVoiced: t1, voicedMs: 0 };
      open.lastVoiced = t1;
      open.voicedMs += t1 - t0;
    } else if (open && t1 - open.lastVoiced > o.hangoverMs) {
      close(open);
      open = null;
    }
  }
  if (open) close(open);

  // 4: drop clicks, merge close regions, pad, split long ones.
  const merged: Region[] = [];
  for (const r of regions.filter((x) => x.voicedMs >= o.minSpeechMs)) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < o.mergeGapMs) {
      last.end = r.end;
      last.voicedMs += r.voicedMs;
    } else {
      merged.push({ ...r });
    }
  }

  const padded: Array<{ start: number; end: number }> = [];
  for (const r of merged) {
    const start = Math.max(0, r.start - o.padMs);
    const end = Math.min(durationMs, r.end + o.padMs);
    const last = padded[padded.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else padded.push({ start, end });
  }

  const out: SpeechSegment[] = [];
  for (const r of padded) {
    let start = r.start;
    while (r.end - start > o.maxSegmentMs) {
      const cut = quietestCut(levels, frameMs, start + o.maxSegmentMs / 2, start + o.maxSegmentMs);
      out.push(toMs(start, cut));
      start = cut;
    }
    out.push(toMs(start, r.end));
  }
  return out.filter((s) => s.end_ms > s.start_ms);
}

/** The frame boundary in [from, to] with the lowest level (the latest one on a tie). */
function quietestCut(levels: Float64Array, frameMs: number, from: number, to: number): number {
  const a = Math.ceil(from / frameMs);
  const b = Math.floor(to / frameMs);
  let best = b;
  let bestDb = Infinity;
  for (let f = a; f < b && f < levels.length; f++) {
    if (levels[f] <= bestDb) {
      bestDb = levels[f];
      best = f;
    }
  }
  return Math.min(to, best * frameMs);
}

const toMs = (start: number, end: number): SpeechSegment => ({ start_ms: Math.floor(start), end_ms: Math.ceil(end) });
