// Fix round 1 (APP review), core side:
//  I3  streaming VAD over a PCM reader; a long call never needs the whole channel in memory
//  M1  Retry after transcript_missing transcribes again
//  M5  Solace's caps checked before sending
//  M6  one Gemini 400 marks that segment "[không nghe rõ]"; the call fails only when most segments fail
//  +   a built payload passes Solace's own validateTranscriptUpload (read-only import from the Solace worktree)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectSpeech, detectSpeechStream, type PcmReader } from "../../src/core/vad";
import { transcribeJob, sendJob, UNCLEAR_SEGMENT_TEXT, type PcmSource } from "../../src/core/pipeline";
import { JobQueue, QueueRunner, type Job, type NewJob } from "../../src/core/queue";
import { buildTranscriptFile, formatIsoWithOffset, readTranscriptFile, toPayload, writeTranscriptFiles } from "../../src/core/transcript";
import { serialisePayload } from "../../src/core/solaceClient";
import { solaceLimitProblems, SOLACE_MAX_CHARS, SOLACE_MAX_TURNS } from "../../src/core/limits";
import type { FetchLike } from "../../src/core/http";
import type { Turn } from "../../src/core/types";
import { build } from "./signals";

const SR = 16_000;
const SID = "cmh2x9k0a0001qz8v7y6t5r4e";
const T0 = Date.parse("2026-10-26T02:00:00Z");

/** A reader over an in-memory array that records every request size. */
function arrayReader(pcm: Float32Array, reads: number[]): PcmReader {
  return {
    length: pcm.length,
    read: async (start, count) => {
      reads.push(count);
      return pcm.slice(start, Math.min(pcm.length, start + count));
    },
  };
}

describe("streaming VAD (I3)", () => {
  const signal = build(SR, [
    { kind: "silence", ms: 700 }, { kind: "tone", ms: 1300 }, { kind: "silence", ms: 2000 },
    { kind: "noise", ms: 45_000 }, { kind: "silence", ms: 900 }, { kind: "tone", ms: 400 }, { kind: "silence", ms: 500 },
  ], 3);

  it("finds exactly the segments the whole-array VAD finds, whatever the chunk size", async () => {
    const whole = detectSpeech(signal, SR);
    expect(whole.length).toBeGreaterThan(2);
    for (const chunk of [1234, 16_000, 160_000, signal.length]) {
      const reads: number[] = [];
      expect(await detectSpeechStream(arrayReader(signal, reads), SR, {}, chunk)).toEqual(whole);
      expect(Math.max(...reads)).toBeLessThanOrEqual(chunk);
    }
  });
});

/** 4 hours of near-silence with a few words, generated on demand: nothing ever holds the whole channel. */
function longChannel(totalSamples: number, speechAtSec: number[], reads: number[]): PcmReader {
  return {
    length: totalSamples,
    read: async (start, count) => {
      reads.push(count);
      const n = Math.max(0, Math.min(count, totalSamples - start));
      const out = new Float32Array(n);
      for (const at of speechAtSec) {
        const a = at * SR;
        const b = a + 2 * SR;
        for (let i = Math.max(a, start); i < Math.min(b, start + n); i++) out[i - start] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR);
      }
      return out;
    },
  };
}

let root: string;
let folder: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "tcr-fix1-"));
  folder = path.join(root, SID);
  await mkdir(folder, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const geminiOk: FetchLike = async () => ({
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "xin chào" }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 3 } }),
});

const newJob = (over: Partial<NewJob> = {}): NewJob => ({
  id: SID, sessionId: SID, dialMode: "3cx", folder,
  startedAt: formatIsoWithOffset(T0, 420), endedAt: formatIsoWithOffset(T0 + 4 * 3600_000, 420),
  sendBy: new Date(T0 + 72 * 3600_000).toISOString(), ...over,
});
const asJob = (n: NewJob, stage: Job["stage"] = "transcribing"): Job =>
  ({ ...n, stage, attempts: 0, nextAttemptAt: null, callId: null, duplicate: false, failure: null, createdAt: "", updatedAt: "" });

describe("a 4-hour call is transcribed with bounded reads (I3)", () => {
  it("never asks the reader for more than a chunk or one segment", async () => {
    const reads: number[] = [];
    const total = 4 * 3600 * SR;
    const source: PcmSource = {
      sampleRate: SR,
      left: longChannel(total, [60, 7200], reads),
      right: longChannel(total, [3600, 14_000], reads),
    };
    const r = await transcribeJob({
      openPcm: async () => source,
      getGeminiKey: async () => "AIzaFAKE-key-0001",
      getModel: () => "gemini-3.5-transcribe",
      gemini: { fetch: geminiOk, sleep: async () => undefined, maxAttempts: 1 },
      appVersion: "0.1.0",
    }, asJob(newJob()));
    expect(r).toEqual({ ok: true });
    const f = await readTranscriptFile(folder, SID);
    expect(f!.transcript.segments.map((s) => s.speaker)).toEqual(["ta", "candidate", "ta", "candidate"]);
    // 10 s chunks for the VAD pass, ≤ ~30 s per segment read: never anything near a whole channel.
    expect(Math.max(...reads)).toBeLessThanOrEqual(31 * SR);
    expect(reads.reduce((a, b) => a + b, 0)).toBeLessThan(2.1 * total + 10 * 31 * SR);
  }, 60_000);
});

describe("one bad segment does not fail the call (M6)", () => {
  // Three stretches of speech on the left; Gemini answers 400 INVALID_ARGUMENT to the n-th requests.
  const left = build(SR, [
    { kind: "silence", ms: 500 }, { kind: "tone", ms: 1000 }, { kind: "silence", ms: 2000 },
    { kind: "tone", ms: 1000 }, { kind: "silence", ms: 2000 }, { kind: "tone", ms: 1000 }, { kind: "silence", ms: 500 },
  ], 4);
  const right = new Float32Array(left.length);
  const geminiFailing = (bad: (n: number) => boolean): { fetch: FetchLike; calls: () => number } => {
    let n = 0;
    return {
      calls: () => n,
      fetch: async () => {
        n++;
        if (bad(n)) return { status: 400, headers: { get: () => null }, text: async () => JSON.stringify({ error: { status: "INVALID_ARGUMENT" } }) };
        return geminiOk("", { method: "POST", headers: {} });
      },
    };
  };
  const deps = (fetch: FetchLike) => ({
    loadPcm: async () => ({ left, right, sampleRate: SR }),
    getGeminiKey: async () => "AIzaFAKE-key-0001",
    getModel: () => "gemini-3.5-transcribe",
    gemini: { fetch, sleep: async () => undefined, maxAttempts: 1 },
    appVersion: "0.1.0",
  });

  it("marks the bad segment and keeps the others", async () => {
    const g = geminiFailing((n) => n === 2);
    expect(await transcribeJob(deps(g.fetch), asJob(newJob()))).toEqual({ ok: true });
    const texts = (await readTranscriptFile(folder, SID))!.transcript.segments.map((s) => s.text);
    expect(texts).toEqual(["xin chào", UNCLEAR_SEGMENT_TEXT, "xin chào"]);
    expect(UNCLEAR_SEGMENT_TEXT).toBe("[không nghe rõ]");
  });

  it("fails the call when most segments fail, and a retry asks Gemini again for them", async () => {
    const g = geminiFailing((n) => n <= 2);
    expect(await transcribeJob(deps(g.fetch), asJob(newJob()))).toEqual({ ok: false, retryable: false, reason: "gemini_bad_request" });
    expect(existsSync(path.join(folder, `${SID}.transcript.json`))).toBe(false);
    const again = geminiFailing(() => false);
    expect(await transcribeJob(deps(again.fetch), asJob(newJob()))).toEqual({ ok: true });
    expect(again.calls()).toBe(2); // the one good segment was kept in the checkpoint
  });
});

describe("Retry after a missing transcript transcribes again (M1)", () => {
  it("puts the job back to 'recorded', so the next run makes the transcript and sends it", async () => {
    const pcm = build(SR, [{ kind: "silence", ms: 500 }, { kind: "tone", ms: 1000 }, { kind: "silence", ms: 500 }], 5);
    const now = () => T0 + 3600_000;
    const q = await JobQueue.open(path.join(root, "queue.json"), { now });
    await q.add(newJob({ endedAt: formatIsoWithOffset(T0 + 2000, 420) }));
    await q.setStage(SID, "transcribed"); // as if transcribed, but the file is gone
    let transcribed = 0;
    let sent = 0;
    const runner = new QueueRunner({
      queue: q,
      now,
      transcribe: async (j) => {
        transcribed++;
        return transcribeJob({
          loadPcm: async () => ({ left: pcm, right: new Float32Array(pcm.length), sampleRate: SR }),
          getGeminiKey: async () => "AIzaFAKE-key-0001",
          getModel: () => "gemini-3.5-transcribe",
          gemini: { fetch: geminiOk, sleep: async () => undefined, maxAttempts: 1 },
          appVersion: "0.1.0",
        }, j);
      },
      send: async (j, t) => {
        const solace: FetchLike = async () => ({ status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ call_id: "call_1" }) });
        const r = await sendJob({ solace: { fetch: solace }, getBaseUrl: () => "https://solace.test" }, j, t);
        if (r.ok) sent++;
        return r;
      },
      getUploadTicket: async () => "U".repeat(43),
    });
    await runner.drain();
    expect(q.get(SID)).toMatchObject({ stage: "failed", failure: { reason: "transcript_missing", stage: "recorded" } });
    await q.retry(SID);
    await runner.drain();
    expect(transcribed).toBe(1);
    expect(sent).toBe(1);
    expect(q.get(SID)!.stage).toBe("sent");
  });
});

function payloadWith(turns: Turn[], durationS = 3600) {
  const file = buildTranscriptFile({
    sessionId: SID, dialMode: "self_dial", startedAtMs: T0, endedAtMs: T0 + durationS * 1000, tzOffsetMinutes: 420,
    turns, model: "gemini-3.5-transcribe", appVersion: "0.1.0",
  });
  return toPayload(file)!;
}

describe("Solace's caps are checked before sending (M5)", () => {
  it("names the cap a transcript breaks", () => {
    const many: Turn[] = Array.from({ length: SOLACE_MAX_TURNS + 1 }, (_, i) => ({ speaker: i % 2 ? "ta" : "candidate", start_ms: i * 100, end_ms: i * 100 + 50, text: "ừ" }));
    expect(SOLACE_MAX_TURNS).toBe(5000);
    expect(SOLACE_MAX_CHARS).toBe(300_000);
    expect(solaceLimitProblems(payloadWith(many))).toEqual(["more than 5,000 turns"]);
    const long: Turn[] = Array.from({ length: 80 }, (_, i) => ({ speaker: "ta", start_ms: i * 1000, end_ms: i * 1000 + 900, text: "chào bạn ".repeat(420) }));
    expect(solaceLimitProblems(payloadWith(long))).toEqual(["more than 300,000 characters"]);
    expect(solaceLimitProblems(payloadWith(long.slice(0, 10)))).toEqual([]);
  });

  it("fails the send with transcript_over_limits and never calls Solace", async () => {
    const long: Turn[] = Array.from({ length: 80 }, (_, i) => ({ speaker: "ta", start_ms: i * 1000, end_ms: i * 1000 + 900, text: "chào bạn ".repeat(420) }));
    const file = buildTranscriptFile({ sessionId: SID, dialMode: "3cx", startedAtMs: T0, endedAtMs: T0 + 3600_000, tzOffsetMinutes: 420, turns: long, model: "m", appVersion: "0.1.0" });
    await writeTranscriptFiles(folder, SID, file);
    let called = 0;
    const solace: FetchLike = async () => {
      called++;
      return { status: 201, headers: { get: () => null }, text: async () => "{}" };
    };
    const r = await sendJob({ solace: { fetch: solace }, getBaseUrl: () => "https://solace.test" }, asJob(newJob(), "sending"), "U".repeat(43));
    expect(r).toEqual({ ok: false, retryable: false, reason: "transcript_over_limits", details: ["more than 300,000 characters"] });
    expect(called).toBe(0);
  });
});

// Solace's own validator, imported read-only from the Solace worktree (never edited from here).
const SOLACE_CONTRACT = "C:/Users/LAP15911/solace-worktrees/call-recorder/backend/src/modules/call-recorder/contract.ts";

describe.skipIf(!existsSync(SOLACE_CONTRACT))("a built payload passes Solace's real validateTranscriptUpload", () => {
  it("accepts the app's payload as sent, with nothing to repair", async () => {
    const { validateTranscriptUpload } = (await import(/* @vite-ignore */ SOLACE_CONTRACT)) as {
      validateTranscriptUpload(body: unknown): { ok: boolean; reasons?: string[]; repairs?: Record<string, unknown> };
    };
    const raw: Turn[] = [
      { speaker: "ta", start_ms: 0, end_ms: 4200, text: "Chào bạn,\nmình là Lan bên VNGGames. ──── ok" },
      { speaker: "candidate", start_ms: 3900, end_ms: 9000, text: `Dạ em chào chị. ${"A".repeat(450)}` },
      { speaker: "ta", start_ms: 9100, end_ms: 9100, text: "Mức lương mong muốn của bạn là bao nhiêu?" },
    ];
    // Through the same cleaning the pipeline applies when it builds the file.
    const { assembleTurns } = await import("../../src/core/transcript");
    const turns = assembleTurns(
      raw.filter((t) => t.speaker === "ta").map(({ start_ms, end_ms, text }) => ({ start_ms, end_ms, text })),
      raw.filter((t) => t.speaker === "candidate").map(({ start_ms, end_ms, text }) => ({ start_ms, end_ms, text })),
    );
    const payload = payloadWith(turns, 10);
    const body = JSON.parse(serialisePayload(payload));
    const r = validateTranscriptUpload(body);
    expect(r.reasons ?? []).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.repairs).toEqual({});
    expect(solaceLimitProblems(payload)).toEqual([]);
  });

  it("refuses what the app's own limit check refuses", async () => {
    const { validateTranscriptUpload } = (await import(/* @vite-ignore */ SOLACE_CONTRACT)) as { validateTranscriptUpload(body: unknown): { ok: boolean } };
    const many: Turn[] = Array.from({ length: SOLACE_MAX_TURNS + 1 }, (_, i) => ({ speaker: "ta", start_ms: i * 100, end_ms: i * 100 + 50, text: "ừ" }));
    const p = payloadWith(many);
    expect(solaceLimitProblems(p)).not.toEqual([]);
    expect(validateTranscriptUpload(JSON.parse(serialisePayload(p))).ok).toBe(false);
  });
});
