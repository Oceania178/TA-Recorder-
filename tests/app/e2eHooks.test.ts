// Development-only end-to-end test hooks (scripts/e2e): inert in the installed app, and only with --dev --e2e.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readE2eHooks } from "../../src/main/e2eHooks";
import { CallJobs } from "../../src/main/callJobs";
import { fakeCallSignal, FAKE_CALL_TURNS } from "../../src/renderer/fakeAudio";
import { detectSpeech, writeCallMarker, type FetchLike } from "../../src/core";

const ALL = ["--dev", "--e2e", "--e2e-audio", "--e2e-gemini-endpoint=http://127.0.0.1:4190", "--e2e-clock-offset-ms=262800000"];

describe("readE2eHooks: inert unless a development build is started with --dev --e2e", () => {
  it("the installed (packaged) app ignores every e2e flag", () => {
    expect(readE2eHooks(["TA Call Recorder.exe", ...ALL], true)).toBeNull();
  });

  it("a development build without --e2e, or without --dev, ignores them too", () => {
    expect(readE2eHooks(["electron", ".", ...ALL.filter((a) => a !== "--e2e")], false)).toBeNull();
    expect(readE2eHooks(["electron", ".", ...ALL.filter((a) => a !== "--dev")], false)).toBeNull();
  });

  it("a development build with --dev --e2e reads the hooks", () => {
    expect(readE2eHooks(["electron", ".", ...ALL], false)).toEqual({
      fakeAudio: true,
      geminiEndpoint: "http://127.0.0.1:4190",
      clockOffsetMs: 262_800_000,
      importFile: null,
    });
  });

  it("defaults: real audio, the real Gemini address, the real clock", () => {
    expect(readE2eHooks(["electron", ".", "--dev", "--e2e"], false)).toEqual({ fakeAudio: false, geminiEndpoint: null, clockOffsetMs: 0, importFile: null });
  });

  it("the Gemini override must be plain http on this laptop (no other host, no path)", () => {
    for (const bad of ["https://evil.example", "http://10.0.0.5:4190", "http://127.0.0.1:4190/x", "http://localhost.evil.example:1", "file:///c:/x"]) {
      expect(readE2eHooks(["electron", ".", "--dev", "--e2e", `--e2e-gemini-endpoint=${bad}`], false)?.geminiEndpoint, bad).toBeNull();
    }
    expect(readE2eHooks(["electron", ".", "--dev", "--e2e", "--e2e-gemini-endpoint=http://localhost:9"], false)?.geminiEndpoint).toBe("http://localhost:9");
  });

  it("the clock offset is whole ms, forward only, at most 30 days", () => {
    const off = (v: string) => readE2eHooks(["electron", ".", "--dev", "--e2e", `--e2e-clock-offset-ms=${v}`], false)?.clockOffsetMs;
    expect(off("-5")).toBe(0);
    expect(off("abc")).toBe(0);
    expect(off("1.5")).toBe(0);
    expect(off(String(31 * 86_400_000))).toBe(0);
    expect(off("1000")).toBe(1000);
  });
});

describe("fakeCallSignal: speech-like bursts, left = TA, right = candidate", () => {
  const SR = 16_000;
  it("is deterministic and finds one VAD segment per scripted turn on each channel", () => {
    const a = fakeCallSignal(SR);
    const b = fakeCallSignal(SR);
    expect(a.left).toEqual(b.left);
    const ta = FAKE_CALL_TURNS.filter((t) => t.speaker === "ta");
    const cand = FAKE_CALL_TURNS.filter((t) => t.speaker === "candidate");
    const segL = detectSpeech(a.left, SR);
    const segR = detectSpeech(a.right, SR);
    expect(segL).toHaveLength(ta.length);
    expect(segR).toHaveLength(cand.length);
    segL.forEach((s, i) => {
      expect(Math.abs(s.start_ms - ta[i].startMs)).toBeLessThan(400);
      expect(Math.abs(s.end_ms - ta[i].endMs)).toBeLessThan(500);
    });
    segR.forEach((s, i) => expect(Math.abs(s.start_ms - cand[i].startMs)).toBeLessThan(400));
  });

  it("each turn has its own pitch, so a fake Gemini can tell the segments apart", () => {
    const hz = FAKE_CALL_TURNS.map((t) => t.hz);
    expect(new Set(hz).size).toBe(hz.length);
  });
});

describe("CallJobs: the Gemini address override reaches the Gemini client", () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "tacr-e2e-"));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("sends segments to geminiEndpoint when it is set", async () => {
    const id = "20261030-100000-a1b2c3";
    const folder = join(base, "rec", id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${id}.left.webm`), "L");
    await writeCallMarker(folder, { id, startedAt: "2026-10-30T03:00:00.000Z", endedAt: "2026-10-30T03:00:20.000Z" });
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      const body = { candidates: [{ content: { parts: [{ text: "xin chào" }] }, finishReason: "STOP" }] };
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    };
    const sig = fakeCallSignal(16_000);
    const jobs = await CallJobs.open({
      queueFile: join(base, "queue.json"),
      secrets: { getGeminiKey: async () => "fake", getTicket: async () => null, heldTicket: async () => null, forgetTicket: async () => undefined },
      getBaseUrl: () => null,
      getModel: () => "gemini-3.5-transcribe",
      fetch,
      loadPcm: async () => ({ left: sig.left, right: sig.right, sampleRate: 16_000 }),
      appVersion: "0.1.0",
      geminiEndpoint: "http://127.0.0.1:4190",
      geminiSleep: async () => undefined,
      setTimer: () => null,
      clearTimer: () => undefined,
    });
    await jobs.add({ id, folder, startedAtMs: Date.parse("2026-10-30T03:00:00Z"), endedAtMs: Date.parse("2026-10-30T03:00:20Z"), session: null });
    jobs.close();
    expect(urls.length).toBe(FAKE_CALL_TURNS.length);
    for (const u of urls) expect(u.startsWith("http://127.0.0.1:4190/v1beta/models/gemini-3.5-transcribe:generateContent")).toBe(true);
  });
});
