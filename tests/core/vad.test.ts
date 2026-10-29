import { describe, it, expect } from "vitest";
import { detectSpeech, DEFAULT_VAD } from "../../src/core/vad";
import { build } from "./signals";

const SR = 16_000;
/** Within ±tol ms. */
const near = (actual: number, expected: number, tol: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);

describe("detectSpeech (option B, D-15)", () => {
  it("finds a tone and a noise burst separated by silence, padded at the edges", () => {
    const pcm = build(SR, [
      { kind: "silence", ms: 1000 },
      { kind: "tone", ms: 2000 },
      { kind: "silence", ms: 1500 },
      { kind: "noise", ms: 1000 },
      { kind: "silence", ms: 1500 },
    ]);
    const segs = detectSpeech(pcm, SR);
    expect(segs).toHaveLength(2);
    const pad = DEFAULT_VAD.padMs;
    near(segs[0].start_ms, 1000 - pad, 40);
    near(segs[0].end_ms, 3000 + DEFAULT_VAD.hangoverMs + pad, 60);
    near(segs[1].start_ms, 4500 - pad, 40);
    near(segs[1].end_ms, 5500 + DEFAULT_VAD.hangoverMs + pad, 60);
  });

  it("merges two bursts with a gap shorter than ~0.6 s", () => {
    const pcm = build(SR, [
      { kind: "silence", ms: 500 },
      { kind: "tone", ms: 800 },
      { kind: "silence", ms: 300 },
      { kind: "tone", ms: 800 },
      { kind: "silence", ms: 800 },
    ]);
    expect(detectSpeech(pcm, SR)).toHaveLength(1);
  });

  it("keeps bursts apart when the gap is long", () => {
    const pcm = build(SR, [
      { kind: "silence", ms: 500 },
      { kind: "tone", ms: 800 },
      { kind: "silence", ms: 2000 },
      { kind: "tone", ms: 800 },
      { kind: "silence", ms: 800 },
    ]);
    expect(detectSpeech(pcm, SR)).toHaveLength(2);
  });

  it("ignores a click shorter than the minimum speech length", () => {
    const pcm = build(SR, [
      { kind: "silence", ms: 1000 },
      { kind: "noise", ms: 40, amp: 0.5 },
      { kind: "silence", ms: 1000 },
    ]);
    expect(detectSpeech(pcm, SR)).toEqual([]);
  });

  it("finds nothing in silence, in digital zero, or in an empty signal", () => {
    expect(detectSpeech(build(SR, [{ kind: "silence", ms: 3000 }]), SR)).toEqual([]);
    expect(detectSpeech(new Float32Array(SR * 2), SR)).toEqual([]);
    expect(detectSpeech(new Float32Array(0), SR)).toEqual([]);
  });

  it("adapts to a loud steady background (hum) and still finds speech above it", () => {
    const hum = 0.02; // ≈ -37 dBFS background
    const pcm = build(SR, [
      { kind: "silence", ms: 2000, noise: hum },
      { kind: "tone", ms: 1500, amp: 0.3, noise: hum },
      { kind: "silence", ms: 2000, noise: hum },
    ]);
    const segs = detectSpeech(pcm, SR);
    expect(segs).toHaveLength(1);
    near(segs[0].start_ms, 2000 - DEFAULT_VAD.padMs, 60);
  });

  it("splits speech longer than the maximum segment, every piece within the maximum", () => {
    const pcm = build(SR, [{ kind: "silence", ms: 500 }, { kind: "tone", ms: 25_000 }, { kind: "silence", ms: 500 }]);
    const segs = detectSpeech(pcm, SR, { maxSegmentMs: 10_000 });
    expect(segs.length).toBeGreaterThanOrEqual(3);
    for (const s of segs) expect(s.end_ms - s.start_ms).toBeLessThanOrEqual(10_000);
    // contiguous: nothing of the speech is lost between the pieces
    for (let i = 1; i < segs.length; i++) expect(segs[i].start_ms).toBeLessThanOrEqual(segs[i - 1].end_ms);
  });

  it("never pads beyond the signal", () => {
    const pcm = build(SR, [{ kind: "tone", ms: 1000 }]);
    const segs = detectSpeech(pcm, SR);
    expect(segs).toHaveLength(1);
    expect(segs[0].start_ms).toBe(0);
    expect(segs[0].end_ms).toBe(1000);
  });

  it("works at 48 kHz too and returns whole, ordered milliseconds", () => {
    const pcm = build(48_000, [{ kind: "silence", ms: 700 }, { kind: "tone", ms: 900 }, { kind: "silence", ms: 900 }]);
    const segs = detectSpeech(pcm, 48_000);
    expect(segs).toHaveLength(1);
    expect(Number.isInteger(segs[0].start_ms) && Number.isInteger(segs[0].end_ms)).toBe(true);
    expect(segs[0].start_ms).toBeLessThan(segs[0].end_ms);
  });

  it("refuses a nonsense sample rate", () => {
    expect(() => detectSpeech(new Float32Array(10), 0)).toThrow();
  });
});
