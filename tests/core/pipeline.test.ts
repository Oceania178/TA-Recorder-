import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { transcribeJob, sendJob, type PipelineDeps, type SendDeps } from "../../src/core/pipeline";
import { JobQueue, QueueRunner, type Job, type NewJob } from "../../src/core/queue";
import { readTranscriptFile } from "../../src/core/transcript";
import { formatIsoWithOffset } from "../../src/core/transcript";
import type { FetchLike, RequestInitLike } from "../../src/core/http";
import { build } from "./signals";

const SR = 16_000;
const KEY = "AIzaFAKE-e2e-key";
const SOLACE = "https://solace.test";
const UPLOAD_TICKET = "U".repeat(43);
const SID = "cmh2x9k0a0001qz8v7y6t5r4e";
const T0 = Date.parse("2026-10-26T02:00:00Z");

/** Left (TA): speech 0.5–2.0 s and 5.0–6.0 s. Right (candidate): speech 2.5–4.0 s. 7 s in all. */
const left = build(SR, [{ kind: "silence", ms: 500 }, { kind: "tone", ms: 1500 }, { kind: "silence", ms: 3000 }, { kind: "tone", ms: 1000 }, { kind: "silence", ms: 1000 }], 1);
const right = build(SR, [{ kind: "silence", ms: 2500 }, { kind: "noise", ms: 1500 }, { kind: "silence", ms: 3000 }], 2);

interface Seen { url: string; init: RequestInitLike }

/** A fake network: Gemini answers with the size of the audio it got; Solace stores the first upload. */
function fakeNet(o: { geminiDown?: (n: number) => boolean; solaceStatus?: number } = {}) {
  const gemini: Seen[] = [];
  const solace: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      gemini.push({ url, init });
      if (o.geminiDown?.(gemini.length)) return { status: 503, headers: { get: () => null }, text: async () => "" };
      const b64: string = JSON.parse(init.body!).contents[0].parts[1].inline_data.data;
      const ms = Math.round(((Buffer.from(b64, "base64").length - 44) / 32_000) * 1000);
      const body = { candidates: [{ content: { parts: [{ text: `speech ${ms} ms` }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } };
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    }
    if (url.startsWith(SOLACE)) {
      solace.push({ url, init });
      const status = o.solaceStatus ?? (solace.length === 1 ? 201 : 200);
      return { status, headers: { get: () => null }, text: async () => JSON.stringify({ call_id: "call_1", duplicate: status === 200 }) };
    }
    throw new Error(`unexpected address ${url}`);
  };
  return { fetch, gemini, solace };
}

let root: string;
let folder: string;
let now: number;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "tcr-pipeline-"));
  folder = path.join(root, "recordings", SID);
  await mkdir(folder, { recursive: true });
  now = T0;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const newJob = (over: Partial<NewJob> = {}): NewJob => ({
  id: SID, sessionId: SID, dialMode: "self_dial", folder,
  startedAt: formatIsoWithOffset(T0, 420), endedAt: formatIsoWithOffset(T0 + 7000, 420),
  sendBy: new Date(T0 + 72 * 3600_000).toISOString(), ...over,
});

function pipelineDeps(fetch: FetchLike, over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    loadPcm: async () => ({ left, right, sampleRate: SR }),
    getGeminiKey: async () => KEY,
    getModel: () => "gemini-3.5-transcribe",
    gemini: { fetch, sleep: async () => undefined, random: () => 0.5, maxAttempts: 1 },
    appVersion: "0.1.0",
    ...over,
  };
}
const sendDeps = (fetch: FetchLike): SendDeps => ({ solace: { fetch }, getBaseUrl: () => SOLACE });

async function runAll(fetch: FetchLike, q: JobQueue, over: Partial<PipelineDeps> = {}) {
  const runner = new QueueRunner({
    queue: q,
    now: () => now,
    random: () => 0.5,
    transcribe: (j: Job) => transcribeJob(pipelineDeps(fetch, over), j),
    send: (j: Job, t: string) => sendJob(sendDeps(fetch), j, t),
    getUploadTicket: async () => UPLOAD_TICKET,
  });
  await runner.drain();
}

describe("end to end: decoded PCM → VAD → Gemini → transcript files → queue → Solace", () => {
  it("sends one §8.24 transcript with the TA and candidate turns in time order", async () => {
    const net = fakeNet();
    const q = await JobQueue.open(path.join(root, "queue.json"), { now: () => now });
    await q.add(newJob());
    await runAll(net.fetch, q);

    expect(q.get(SID)).toMatchObject({ stage: "sent", callId: "call_1", duplicate: false });
    expect(net.gemini).toHaveLength(3); // three stretches of speech, one request each
    expect(net.solace).toHaveLength(1);

    const sent = net.solace[0];
    expect(sent.url).toBe(`${SOLACE}/api/call-recorder/transcripts`);
    expect(sent.init.headers.Authorization).toBe(`Bearer ${UPLOAD_TICKET}`);
    const body = JSON.parse(sent.init.body!);
    expect(Object.keys(body).sort()).toEqual(["call", "recorder", "schema_version", "session_id", "transcript"]);
    expect(body.session_id).toBe(SID);
    expect(body.call).toEqual({ started_at: "2026-10-26T09:00:00+07:00", ended_at: "2026-10-26T09:00:07+07:00", duration_s: 7, dial_mode: "self_dial", has_content: true });
    expect(body.transcript.model).toBe("gemini-3.5-transcribe");
    expect(body.recorder).toEqual({ app_version: "0.1.0" });
    const segs = body.transcript.segments as Array<{ speaker: string; start_ms: number; end_ms: number; text: string }>;
    expect(segs.map((s) => s.speaker)).toEqual(["ta", "candidate", "ta"]);
    expect(segs[0].start_ms).toBeLessThan(600);
    expect(segs[1].start_ms).toBeGreaterThan(2000);
    expect(segs[2].start_ms).toBeGreaterThan(4500);
    for (const s of segs) expect(s.text).toMatch(/^speech \d+ ms$/);

    // no audio, no key, nothing but text went to Solace (D-139, D-141)
    expect(sent.init.body).not.toContain(KEY);
    expect(sent.init.body).not.toMatch(/[A-Za-z0-9+/=]{200,}/);
    // the key went only to Gemini, in a header
    for (const g of net.gemini) {
      expect(g.init.headers["x-goog-api-key"]).toBe(KEY);
      expect(g.url).not.toContain(KEY);
    }

    // files beside the audio; the checkpoint is gone; the queue file has no ticket and no text
    expect((await readdir(folder)).sort()).toEqual([`${SID}.transcript.json`, `${SID}.transcript.md`]);
    expect(await readTranscriptFile(folder, SID)).toEqual(body);
    const queueFile = await readFile(path.join(root, "queue.json"), "utf8");
    expect(queueFile).not.toContain(UPLOAD_TICKET);
    expect(queueFile).not.toContain("speech ");
  });

  it("resumes an interrupted transcription without paying twice for finished segments", async () => {
    const down = fakeNet({ geminiDown: (n) => n >= 2 });
    const q = await JobQueue.open(path.join(root, "queue.json"), { now: () => now });
    await q.add(newJob());
    await runAll(down.fetch, q);
    expect(q.get(SID)).toMatchObject({ stage: "recorded", attempts: 1 });
    expect(down.gemini).toHaveLength(2); // 1 ok, 1 failed

    const up = fakeNet();
    now += 3_600_000;
    const restarted = await JobQueue.open(path.join(root, "queue.json"), { now: () => now });
    await runAll(up.fetch, restarted);
    expect(restarted.get(SID)!.stage).toBe("sent");
    expect(up.gemini).toHaveLength(2); // only the two segments not done before
  });

  it("a resend after a lost answer is the same body, and Solace's duplicate answer counts as sent (D-85)", async () => {
    const net = fakeNet();
    const q = await JobQueue.open(path.join(root, "queue.json"), { now: () => now });
    await q.add(newJob());
    await runAll(net.fetch, q);
    const job = q.get(SID)!;
    const again = await sendJob(sendDeps(net.fetch), job, UPLOAD_TICKET);
    expect(again).toEqual({ ok: true, callId: "call_1", duplicate: true });
    expect(net.solace[1].init.body).toBe(net.solace[0].init.body);
  });

  it("a call without a session is transcribed, kept local and never sent (D-82)", async () => {
    const net = fakeNet();
    const q = await JobQueue.open(path.join(root, "queue.json"), { now: () => now });
    await q.add(newJob({ id: "local_0001", sessionId: null, dialMode: null, sendBy: null, folder }));
    await runAll(net.fetch, q);
    expect(q.get("local_0001")!.stage).toBe("local_only");
    expect(net.solace).toHaveLength(0);
    expect((await readTranscriptFile(folder, "local_0001"))!.session_id).toBeNull();
  });
});

describe("transcribeJob outcomes", () => {
  const job = (): Job => ({ ...newJob(), stage: "transcribing", attempts: 0, nextAttemptAt: null, callId: null, duplicate: false, failure: null, createdAt: "", updatedAt: "" });

  it("no Gemini key → final, nothing sent anywhere", async () => {
    const net = fakeNet();
    expect(await transcribeJob(pipelineDeps(net.fetch, { getGeminiKey: async () => null }), job()))
      .toEqual({ ok: false, retryable: false, reason: "no_gemini_key" });
    expect(net.gemini).toHaveLength(0);
  });

  it("missing audio → final", async () => {
    const net = fakeNet();
    expect(await transcribeJob(pipelineDeps(net.fetch, { loadPcm: async () => null }), job()))
      .toEqual({ ok: false, retryable: false, reason: "audio_missing" });
  });

  it("a rejected key → final", async () => {
    const fetch: FetchLike = async () => ({ status: 403, headers: { get: () => null }, text: async () => "" });
    expect(await transcribeJob(pipelineDeps(fetch), job())).toEqual({ ok: false, retryable: false, reason: "gemini_key_rejected" });
  });

  it("a silent call still gives a transcript, with has_content false", async () => {
    const net = fakeNet();
    const silent = new Float32Array(SR * 3);
    expect(await transcribeJob(pipelineDeps(net.fetch, { loadPcm: async () => ({ left: silent, right: silent, sampleRate: SR }) }), job())).toEqual({ ok: true });
    const f = await readTranscriptFile(folder, SID);
    expect(f!.call.has_content).toBe(false);
    expect(f!.transcript.segments).toEqual([]);
  });
});

describe("sendJob outcomes", () => {
  const job = (): Job => ({ ...newJob(), stage: "sending", attempts: 0, nextAttemptAt: null, callId: null, duplicate: false, failure: null, createdAt: "", updatedAt: "" });
  const prepared = async () => { await transcribeJob(pipelineDeps(fakeNet().fetch), job()); };
  const solaceAnswer = (status: number, body: unknown): FetchLike => async () => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

  it("maps Solace's answers to queue outcomes", async () => {
    await prepared();
    const cases: Array<[number, unknown, unknown]> = [
      [409, {}, { ok: false, retryable: false, reason: "solace_different_content" }],
      [401, {}, { ok: false, retryable: false, reason: "solace_refused" }],
      [400, { error: "invalid_transcript", reasons: ["call.duration_s must be a number"] }, { ok: false, retryable: false, reason: "solace_invalid", details: ["call.duration_s must be a number"] }],
      [413, {}, { ok: false, retryable: false, reason: "transcript_too_large" }],
      [415, {}, { ok: false, retryable: false, reason: "app_bug" }],
      [503, {}, { ok: false, retryable: true, retryAfterMs: null }],
      [429, {}, { ok: false, retryable: true, retryAfterMs: 60_000 }],
    ];
    for (const [status, body, expected] of cases) {
      expect(await sendJob({ solace: { fetch: solaceAnswer(status, body) }, getBaseUrl: () => SOLACE }, job(), UPLOAD_TICKET)).toEqual(expected);
    }
  });

  it("no pinned Solace address, or no transcript file → final, nothing sent", async () => {
    const net = fakeNet();
    expect(await sendJob({ solace: { fetch: net.fetch }, getBaseUrl: () => null }, job(), UPLOAD_TICKET))
      .toEqual({ ok: false, retryable: false, reason: "no_solace_address" });
    expect(await sendJob(sendDeps(net.fetch), job(), UPLOAD_TICKET))
      .toEqual({ ok: false, retryable: false, reason: "transcript_missing" });
    expect(net.solace).toHaveLength(0);
  });
});
