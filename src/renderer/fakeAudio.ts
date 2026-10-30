// Development-only (--dev --e2e --e2e-audio, see src/main/e2eHooks.ts): a scripted two-person "call" played into
// the recorder's Web Audio graph instead of the mic (left) and the system loopback (right). Each turn is a tone
// with a syllable-like loudness wobble and its own pitch, so the VAD finds it as speech and a fake Gemini can
// tell which turn it was given. Between turns: a faint hiss, like a quiet room.
// Pure: no Web Audio here, so it is unit-tested; capture.ts turns the samples into AudioBuffers.

export interface FakeTurn {
  speaker: "ta" | "candidate";
  startMs: number;
  endMs: number;
  hz: number;
}

/** About 20 s: TA and candidate take turns, three times each. */
export const FAKE_CALL_TURNS: readonly FakeTurn[] = [
  { speaker: "ta", startMs: 500, endMs: 3000, hz: 330 },
  { speaker: "candidate", startMs: 3600, endMs: 6400, hz: 660 },
  { speaker: "ta", startMs: 7000, endMs: 9500, hz: 440 },
  { speaker: "candidate", startMs: 10_200, endMs: 13_200, hz: 770 },
  { speaker: "ta", startMs: 14_000, endMs: 16_000, hz: 550 },
  { speaker: "candidate", startMs: 16_600, endMs: 19_000, hz: 880 },
];

export const FAKE_CALL_MS = 21_000;

/** Same numbers on every run (no Math.random). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function fakeCallSignal(sampleRate: number): { left: Float32Array; right: Float32Array } {
  const n = Math.round((FAKE_CALL_MS / 1000) * sampleRate);
  const out = { left: new Float32Array(n), right: new Float32Array(n) };
  const rnd = seeded(7);
  for (let i = 0; i < n; i++) {
    out.left[i] = 0.001 * (rnd() * 2 - 1);
    out.right[i] = 0.001 * (rnd() * 2 - 1);
  }
  for (const t of FAKE_CALL_TURNS) {
    const ch = t.speaker === "ta" ? out.left : out.right;
    const a = Math.round((t.startMs / 1000) * sampleRate);
    const b = Math.min(n, Math.round((t.endMs / 1000) * sampleRate));
    for (let i = a; i < b; i++) {
      const s = (i - a) / sampleRate;
      // ~4 syllables a second, never fully silent inside the turn; 20 ms fade in and out.
      const syllable = 0.4 + 0.6 * Math.abs(Math.sin(Math.PI * 4 * s));
      const fade = Math.min(1, s / 0.02, (b - i) / sampleRate / 0.02);
      const phase = 2 * Math.PI * t.hz * s;
      ch[i] += 0.3 * syllable * fade * (Math.sin(phase) + 0.25 * Math.sin(2 * phase));
    }
  }
  return out;
}
