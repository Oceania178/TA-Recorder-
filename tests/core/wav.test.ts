import { describe, it, expect } from "vitest";
import { encodeWav, resample, slicePcm, WAV_SAMPLE_RATE } from "../../src/core/wav";
import { build } from "./signals";

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

describe("encodeWav (16 kHz mono 16-bit)", () => {
  it("writes a correct 44-byte PCM header", () => {
    const wav = encodeWav(new Float32Array(16_000), 16_000);
    const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(wav.byteLength).toBe(44 + 32_000);
    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 32_000);
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(ascii(wav, 12, 4)).toBe("fmt ");
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(28, true)).toBe(32_000); // byte rate
    expect(v.getUint16(32, true)).toBe(2); // block align
    expect(v.getUint16(34, true)).toBe(16); // bits
    expect(ascii(wav, 36, 4)).toBe("data");
    expect(v.getUint32(40, true)).toBe(32_000);
  });

  it("converts and clamps samples", () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 2, -2, 0.5]), 16_000);
    const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect([0, 1, 2, 3, 4, 5].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });

  it("downsamples 48 kHz input to 16 kHz", () => {
    const wav = encodeWav(new Float32Array(48_000), 48_000);
    expect(WAV_SAMPLE_RATE).toBe(16_000);
    expect(wav.byteLength).toBe(44 + 32_000);
  });
});

describe("resample", () => {
  it("keeps a DC level and the length ratio", () => {
    const out = resample(new Float32Array(4800).fill(0.25), 48_000, 16_000);
    expect(out.length).toBe(1600);
    for (const s of out) expect(s).toBeCloseTo(0.25, 5);
  });

  it("keeps a speech-band tone's level (no big loss) when downsampling", () => {
    const tone = build(48_000, [{ kind: "tone", ms: 500, hz: 300, amp: 0.5, noise: 0 }]);
    const out = resample(tone, 48_000, 16_000);
    const peak = out.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
    expect(peak).toBeGreaterThan(0.45);
    expect(peak).toBeLessThanOrEqual(0.5001);
  });

  it("upsamples 8 kHz by interpolation and returns the same array when the rate already matches", () => {
    const up = resample(Float32Array.from([0, 1]), 8000, 16_000);
    expect(up.length).toBe(4);
    expect(up[1]).toBeCloseTo(0.5, 5);
    const same = new Float32Array(3);
    expect(resample(same, 16_000, 16_000)).toBe(same);
  });
});

describe("slicePcm", () => {
  it("cuts by milliseconds and clamps to the signal", () => {
    const pcm = Float32Array.from({ length: 16_000 }, (_, i) => i);
    const s = slicePcm(pcm, 16_000, 250, 500);
    expect(s.length).toBe(4000);
    expect(s[0]).toBe(4000);
    expect(slicePcm(pcm, 16_000, 900, 5000).length).toBe(1600);
    expect(slicePcm(pcm, 16_000, 5000, 6000).length).toBe(0);
  });
});
