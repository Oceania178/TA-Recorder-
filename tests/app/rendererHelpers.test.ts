import { describe, expect, it } from "vitest";
import { ElapsedClock, formatElapsed } from "../../src/renderer/elapsedClock";
import { levelFromSamples } from "../../src/renderer/levels";
import { SilenceWatch } from "../../src/renderer/silenceWatch";
import { checkOutputDevices } from "../../src/renderer/outputDevices";

describe("ElapsedClock (P2, R5)", () => {
  it("counts recorded time and leaves pauses out", () => {
    const c = new ElapsedClock();
    c.start(1000);
    expect(c.elapsed(4000)).toBe(3000);
    c.pause(4000);
    expect(c.elapsed(9000)).toBe(3000);
    c.resume(10000);
    expect(c.elapsed(12000)).toBe(5000);
    expect(c.isPaused).toBe(false);
  });

  it("ignores a second pause or a resume while running", () => {
    const c = new ElapsedClock();
    c.start(0);
    c.resume(500);
    c.pause(1000);
    c.pause(2000);
    c.resume(3000);
    expect(c.elapsed(4000)).toBe(2000);
  });

  it("formats as hh:mm:ss", () => {
    expect(formatElapsed(0)).toBe("00:00:00");
    expect(formatElapsed(61_999)).toBe("00:01:01");
    expect(formatElapsed(3_723_000)).toBe("01:02:03");
  });
});

describe("levelFromSamples (P4 meters)", () => {
  it("is 0 for silence and close to 1 for a full-scale tone", () => {
    expect(levelFromSamples(new Float32Array(1024))).toBe(0);
    const tone = Float32Array.from({ length: 1024 }, (_, i) => Math.sin((2 * Math.PI * i) / 32));
    expect(levelFromSamples(tone)).toBeGreaterThan(0.9);
  });

  it("maps -60 dBFS to the bottom and -30 dBFS to the middle", () => {
    const at = (db: number) => new Float32Array(1024).fill(10 ** (db / 20));
    expect(levelFromSamples(at(-70))).toBe(0);
    expect(levelFromSamples(at(-30))).toBeCloseTo(0.5, 2);
  });
});

describe("SilenceWatch (D-42: warn when a channel is silent too long)", () => {
  it("warns once a channel has been silent for the limit, and clears when sound returns", () => {
    const w = new SilenceWatch({ limitMs: 60_000, threshold: 0.05 });
    w.update(0, 0);
    expect(w.update(59_000, 0)).toBe(false);
    expect(w.update(60_000, 0.01)).toBe(true);
    expect(w.update(61_000, 0.3)).toBe(false);
    expect(w.update(100_000, 0)).toBe(false);
  });

  it("does not count paused time", () => {
    const w = new SilenceWatch({ limitMs: 10_000, threshold: 0.05 });
    w.update(0, 0);
    w.reset(5_000);
    expect(w.update(14_000, 0)).toBe(false);
    expect(w.update(15_000, 0)).toBe(true);
  });
});

describe("checkOutputDevices (R4)", () => {
  const dev = (deviceId: string, label: string, kind = "audiooutput") => ({ deviceId, label, kind });

  it("lists output devices and the default one; no warning when calls and media share a device", () => {
    const r = checkOutputDevices([
      dev("default", "Default - Headset Earphone (Jabra Evolve2 40)"),
      dev("communications", "Communications - Headset Earphone (Jabra Evolve2 40)"),
      dev("abc", "Headset Earphone (Jabra Evolve2 40)"),
      dev("def", "Speakers (Realtek(R) Audio)"),
      dev("mic", "Microphone (Jabra)", "audioinput"),
    ]);
    expect(r.outputs).toEqual(["Headset Earphone (Jabra Evolve2 40)", "Speakers (Realtek(R) Audio)"]);
    expect(r.recordedOutput).toBe("Headset Earphone (Jabra Evolve2 40)");
    expect(r.warnings).toEqual([]);
  });

  it("warns when Windows sends calls to a different device than the one recorded", () => {
    const r = checkOutputDevices([
      dev("default", "Default - Speakers (Realtek(R) Audio)"),
      dev("communications", "Communications - Headset Earphone (Jabra Evolve2 40)"),
      dev("abc", "Headset Earphone (Jabra Evolve2 40)"),
      dev("def", "Speakers (Realtek(R) Audio)"),
    ]);
    expect(r.recordedOutput).toBe("Speakers (Realtek(R) Audio)");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/Headset Earphone \(Jabra Evolve2 40\)/);
    expect(r.warnings[0]).toMatch(/Speakers \(Realtek\(R\) Audio\)/);
  });

  it("explains when device names are hidden or there is no output", () => {
    expect(checkOutputDevices([dev("default", "")]).warnings[0]).toMatch(/names are hidden/i);
    expect(checkOutputDevices([]).warnings[0]).toMatch(/no output device/i);
  });
});
