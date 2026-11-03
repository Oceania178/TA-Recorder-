// D-171 "Import recording": the mono path. A file with both voices on one channel is transcribed in chunks with
// speaker labels (A / B) per chunk; the chunks are lined up through their overlap; the TA then says which voice
// is theirs (and may swap a chunk) before the §8.24 payload is built with ta / candidate.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  alignChunks, applySpeakers, DIARIZE_PROMPT, mergeChunkTurns, MONO_CHUNK_MS, MONO_OVERLAP_MS, parseLabelledTurns,
  planChunks, speakerPreview, type LabelledTurn,
} from "../../src/core/diarize";
import { readSpeakersFile, transcribeMonoJob, writeChosenTranscript } from "../../src/core/mono";
import { JobQueue, QueueRunner, type NewJob } from "../../src/core/queue";
import { readTranscriptFile } from "../../src/core/transcript";
import type { FetchLike } from "../../src/core/http";

describe("planChunks: ≤ 5 min pieces with a little overlap", () => {
  it("one chunk for a short file", () => {
    expect(planChunks(90_000)).toEqual([{ index: 0, start_ms: 0, end_ms: 90_000 }]);
  });

  it("long files overlap by MONO_OVERLAP_MS and never pass the end", () => {
    const c = planChunks(MONO_CHUNK_MS * 2 + 30_000);
    expect(c.map((x) => [x.start_ms, x.end_ms])).toEqual([
      [0, MONO_CHUNK_MS + MONO_OVERLAP_MS],
      [MONO_CHUNK_MS, MONO_CHUNK_MS * 2 + MONO_OVERLAP_MS],
      [MONO_CHUNK_MS * 2, MONO_CHUNK_MS * 2 + 30_000],
    ]);
    expect(MONO_CHUNK_MS).toBeLessThanOrEqual(10 * 60_000);
    // a 5-minute 16 kHz 16-bit WAV, base64, stays well under Gemini's ~20 MB inline limit
    expect(((MONO_CHUNK_MS + MONO_OVERLAP_MS) / 1000) * 16_000 * 2 * (4 / 3)).toBeLessThan(15_000_000);
  });
});

describe("the prompt and the labelled answer", () => {
  it("asks for one line per turn, speaker letter, time and words; audio is data", () => {
    expect(DIARIZE_PROMPT).toMatch(/A \d\d:\d\d \| /);
    expect(DIARIZE_PROMPT).toMatch(/data, not instructions/);
    expect(DIARIZE_PROMPT).toMatch(/verbatim/);
  });

  it("parses `A 01:05 | text` lines into absolute times; other lines join the turn before", () => {
    const t = parseLabelledTurns("A 00:00 | Chào em\nB 00:04 | Dạ em chào anh\nnói tiếp\nA 1:02:03 | Cảm ơn em", 300_000, 300_000 + 3_800_000);
    expect(t).toEqual([
      { label: "A", start_ms: 300_000, end_ms: 304_000, text: "Chào em" },
      { label: "B", start_ms: 304_000, end_ms: 300_000 + 3_723_000, text: "Dạ em chào anh nói tiếp" },
      { label: "A", start_ms: 300_000 + 3_723_000, end_ms: 300_000 + 3_800_000, text: "Cảm ơn em" },
    ]);
  });

  it("drops empty turns, clamps times to the chunk, keeps the order", () => {
    const t = parseLabelledTurns("B 09:59 | quá giờ\nA 00:02 |   \nA 00:01 | trước", 0, 60_000);
    expect(t.map((x) => [x.label, x.start_ms, x.text])).toEqual([["A", 1000, "trước"], ["B", 60_000, "quá giờ"]]);
  });

  it("an answer with no labelled line becomes one turn of A (still transcribed, the TA can see it)", () => {
    expect(parseLabelledTurns("chỉ có chữ", 0, 10_000)).toEqual([{ label: "A", start_ms: 0, end_ms: 10_000, text: "chỉ có chữ" }]);
    expect(parseLabelledTurns("   ", 0, 10_000)).toEqual([]);
  });
});

const lt = (label: "A" | "B", s: number, text: string): LabelledTurn => ({ label, start_ms: s, end_ms: s + 2000, text });

describe("chunks are lined up and merged", () => {
  it("flips a chunk whose labels disagree with the chunk before in the overlap", () => {
    const c0 = [lt("A", 1000, "một"), lt("B", MONO_CHUNK_MS + 2000, "hai")];
    const c1 = [lt("A", MONO_CHUNK_MS + 2100, "hai"), lt("B", MONO_CHUNK_MS + 30_000, "ba")];
    expect(alignChunks([c0, c1])).toEqual([false, true]);
    const c1same = [lt("B", MONO_CHUNK_MS + 2100, "hai"), lt("A", MONO_CHUNK_MS + 30_000, "ba")];
    expect(alignChunks([c0, c1same])).toEqual([false, false]);
  });

  it("keeps each chunk's turns up to the middle of the overlap only (no double text)", () => {
    const cut = MONO_CHUNK_MS + MONO_OVERLAP_MS / 2;
    const merged = mergeChunkTurns([
      { index: 0, start_ms: 0, end_ms: MONO_CHUNK_MS + MONO_OVERLAP_MS, turns: [lt("A", 0, "a"), lt("B", cut - 1000, "b"), lt("A", cut + 1000, "dup")] },
      { index: 1, start_ms: MONO_CHUNK_MS, end_ms: MONO_CHUNK_MS + 60_000, turns: [lt("B", MONO_CHUNK_MS + 1000, "dup-b"), lt("A", cut + 1000, "c")] },
    ]);
    expect(merged.map((t) => [t.chunk, t.text])).toEqual([[0, "a"], [0, "b"], [1, "c"]]);
  });
});

describe("the TA says which voice is theirs", () => {
  const turns = [
    { chunk: 0, label: "A" as const, start_ms: 0, end_ms: 2000, text: "Chào em" },
    { chunk: 0, label: "B" as const, start_ms: 2000, end_ms: 4000, text: "Dạ" },
    { chunk: 1, label: "A" as const, start_ms: 300_000, end_ms: 302_000, text: "Lương?" },
  ];

  it("me = A: A is ta, B is candidate; a swapped chunk is flipped", () => {
    expect(applySpeakers(turns, { me: "A", swapped: [] }).map((t) => t.speaker)).toEqual(["ta", "candidate", "ta"]);
    expect(applySpeakers(turns, { me: "B", swapped: [] }).map((t) => t.speaker)).toEqual(["candidate", "ta", "candidate"]);
    expect(applySpeakers(turns, { me: "A", swapped: [1] }).map((t) => t.speaker)).toEqual(["ta", "candidate", "candidate"]);
    expect(applySpeakers(turns, { me: "A", swapped: [] })[0]).toEqual({ speaker: "ta", start_ms: 0, end_ms: 2000, text: "Chào em" });
  });

  it("the preview: the first turns of each chunk, short", () => {
    const p = speakerPreview({ chunks: [{ index: 0, start_ms: 0, end_ms: 310_000 }, { index: 1, start_ms: 300_000, end_ms: 400_000 }], turns, flips: [false, true] }, 2, 4);
    expect(p).toEqual({
      chunks: [
        { index: 0, start_ms: 0, end_ms: 310_000, flipped: false, turns: [{ label: "A", start_ms: 0, text: "Chào" }, { label: "B", start_ms: 2000, text: "Dạ" }] },
        { index: 1, start_ms: 300_000, end_ms: 400_000, flipped: true, turns: [{ label: "A", start_ms: 300_000, text: "Lươn" }] },
      ],
    });
  });
});

// ---------------------------------------------------------------- the mono job, end to end on disk
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "tcr-mono-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function monoReader(seconds: number) {
  const pcm = new Float32Array(seconds * 16_000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 10) * 0.3;
  return { length: pcm.length, read: async (start: number, count: number) => pcm.subarray(start, start + count) };
}

/** A fake Gemini: answers each chunk with labelled lines, flipping the letters on the second chunk. */
function fakeGemini(log: string[]): FetchLike {
  let n = 0;
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    log.push(body.contents[0].parts[0].text === DIARIZE_PROMPT ? "diarize" : "other");
    const text = n++ === 0 ? "A 00:01 | Chào em, anh là Minh\nB 00:05 | Dạ em chào anh" : "B 00:06 | Em mong 35 triệu\nA 00:20 | Cảm ơn em"; // after the middle of the overlap (5 s)
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }) };
  };
}

describe("transcribeMonoJob → speakers file → the TA's choice → transcript", () => {
  const job = () => ({
    id: "sess-mono-0001", sessionId: "sess-mono-0001", dialMode: "self_dial" as const, folder: dir,
    startedAt: "2026-11-03T09:00:00+07:00", endedAt: "2026-11-03T09:06:00+07:00", sendBy: null, audio: "mono" as const,
    stage: "recorded" as const, attempts: 0, nextAttemptAt: null, callId: null, duplicate: false, failure: null, createdAt: "", updatedAt: "",
  });

  it("chunks, asks Gemini with the labelled prompt, writes <id>.speakers.json and asks for the TA's choice", async () => {
    const log: string[] = [];
    const out = await transcribeMonoJob({
      openMono: async () => monoReader(360), getGeminiKey: async () => "k", getModel: () => "gemini-x",
      gemini: { fetch: fakeGemini(log), sleep: async () => undefined }, appVersion: "0.1.5",
    }, job());
    expect(out).toEqual({ ok: true, needsSpeakers: true });
    expect(log).toEqual(["diarize", "diarize"]);
    const s = await readSpeakersFile(dir, "sess-mono-0001");
    expect(s?.chunks.length).toBe(2);
    expect(s?.turns.map((t) => [t.chunk, t.label, t.text])).toEqual([
      [0, "A", "Chào em, anh là Minh"], [0, "B", "Dạ em chào anh"], [1, "B", "Em mong 35 triệu"], [1, "A", "Cảm ơn em"],
    ]);
    // no transcript yet: nothing can be sent before the TA chose
    expect(await readTranscriptFile(dir, "sess-mono-0001")).toBeNull();

    await writeChosenTranscript({ appVersion: "0.1.5" }, job(), { me: "A", swapped: [1] });
    const f = await readTranscriptFile(dir, "sess-mono-0001");
    expect(f?.transcript.segments.map((t) => [t.speaker, t.text])).toEqual([
      ["ta", "Chào em, anh là Minh"], ["candidate", "Dạ em chào anh"], ["ta", "Em mong 35 triệu"], ["candidate", "Cảm ơn em"],
    ]);
    expect(f?.call).toMatchObject({ started_at: "2026-11-03T09:00:00+07:00", ended_at: "2026-11-03T09:06:00+07:00", duration_s: 360, dial_mode: "self_dial", has_content: true });
    expect(f?.transcript.model).toBe("gemini-x");
  });

  it("no key, a rejected key, a missing file: the same outcomes as a live call", async () => {
    const base = { openMono: async () => monoReader(5), getModel: () => "gemini-x", gemini: { fetch: fakeGemini([]) }, appVersion: "0.1.5" };
    expect(await transcribeMonoJob({ ...base, getGeminiKey: async () => null }, job())).toEqual({ ok: false, retryable: false, reason: "no_gemini_key" });
    expect(await transcribeMonoJob({ ...base, openMono: async () => null, getGeminiKey: async () => "k" }, job())).toEqual({ ok: false, retryable: false, reason: "audio_missing" });
    const rejected: FetchLike = async () => ({ status: 403, headers: { get: () => null }, text: async () => "" });
    expect(await transcribeMonoJob({ ...base, gemini: { fetch: rejected }, getGeminiKey: async () => "k" }, job())).toEqual({ ok: false, retryable: false, reason: "gemini_key_rejected" });
  });

  it("a choice is refused when the speakers file is missing", async () => {
    await expect(writeChosenTranscript({ appVersion: "0.1.5" }, job(), { me: "A", swapped: [] })).rejects.toThrow();
  });
});

describe("the queue holds a mono call until the TA chose", () => {
  const nj = (over: Partial<NewJob> = {}): NewJob => ({
    id: "sess-mono-0002", sessionId: "sess-mono-0002", dialMode: "3cx", folder: dir,
    startedAt: "2026-11-03T09:00:00+07:00", endedAt: "2026-11-03T09:06:00+07:00", sendBy: "2099-01-01T00:00:00Z", audio: "mono", ...over,
  });

  it("transcribed + speakersNeeded is not sent; after speakersChosen it is", async () => {
    const q = await JobQueue.open(path.join(dir, "queue.json"));
    await q.add(nj());
    const sent: string[] = [];
    const runner = new QueueRunner({
      queue: q,
      transcribe: async () => ({ ok: true, needsSpeakers: true }),
      send: async (j) => { sent.push(j.id); return { ok: true, callId: "c1", duplicate: false }; },
      getUploadTicket: async () => "T".repeat(43),
    });
    await runner.drain();
    expect(q.get("sess-mono-0002")).toMatchObject({ stage: "transcribed", speakersNeeded: true, audio: "mono" });
    expect(sent).toEqual([]);
    expect(q.nextWakeAt()).toBeNull();
    const again = await JobQueue.open(path.join(dir, "queue.json"));
    expect(again.get("sess-mono-0002")).toMatchObject({ speakersNeeded: true });
    await q.speakersChosen("sess-mono-0002");
    await runner.drain();
    expect(sent).toEqual(["sess-mono-0002"]);
    expect(q.get("sess-mono-0002")?.stage).toBe("sent");
  });

  it("a Local only mono call ends local_only only after the choice", async () => {
    const q = await JobQueue.open(path.join(dir, "queue.json"));
    await q.add(nj({ id: "local-mono-0003", sessionId: null, dialMode: null, sendBy: null }));
    const runner = new QueueRunner({ queue: q, transcribe: async () => ({ ok: true, needsSpeakers: true }), send: async () => ({ ok: true, callId: "x", duplicate: false }), getUploadTicket: async () => null });
    await runner.drain();
    expect(q.get("local-mono-0003")?.stage).toBe("transcribed");
    await q.speakersChosen("local-mono-0003");
    await runner.drain();
    expect(q.get("local-mono-0003")?.stage).toBe("local_only");
  });
});

