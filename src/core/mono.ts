// core/mono.ts — D-171 "Import recording": transcribing a MONO import (both voices on one channel).
//
// transcribeMonoJob (recorded → transcribed, waiting for the TA's choice):
//   the 16 kHz mono PCM of the import → chunks (diarize.ts planChunks) → each chunk as one WAV to Gemini with
//   DIARIZE_PROMPT (inline, D-139) → labelled turns → chunks lined up and merged → `<id>.speakers.json` in the
//   call's folder. Finished chunks are kept in `<id>.mono-progress.json`, so a restart or an outage never pays
//   twice for the same audio (as pipeline.ts does for a live call). The outcome asks the queue to hold the call
//   until the TA says which voice is theirs (queue.ts `needsSpeakers`): no transcript file exists before that,
//   so nothing can be sent with the wrong speakers.
// writeChosenTranscript: the TA's choice → the usual `<id>.transcript.json` / `.md` (ta / candidate), the
//   same files a live call has; sending and "Local only" then go exactly as for a live call.
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomicWrite";
import {
  alignChunks, applySpeakers, DIARIZE_PROMPT, mergeChunkTurns, parseLabelledTurns, planChunks,
  type Chunk, type SpeakerChoice, type SpeakersData,
} from "./diarize";
import { transcribeSegment, type GeminiDeps } from "./gemini";
import { isoOffsetMinutes } from "./pipeline";
import type { FailureReason, Job, StepOutcome } from "./queue";
import { buildTranscriptFile, sanitiseTurnText, writeTranscriptFiles } from "./transcript";
import type { PcmReader } from "./vad";
import { encodeWav } from "./wav";

/** The import's PCM is 16 kHz, like a live call's temp files (main pcmFiles.ts). */
export const MONO_SAMPLE_RATE = 16_000;

export interface MonoDeps {
  /** The import's mono 16 kHz samples, or null when the audio is missing. */
  openMono(job: Job): Promise<(PcmReader & { close?(): Promise<void> }) | null>;
  getGeminiKey(): Promise<string | null>;
  getModel(): string;
  gemini: GeminiDeps;
  appVersion: string;
}

export interface SpeakersFile extends SpeakersData {
  version: 1;
  model: string;
  requests: number;
  totalTokens: number;
}

interface MonoCheckpoint {
  version: 1;
  model: string;
  /** chunk index → Gemini's labelled answer. */
  done: Record<string, string>;
  requests: number;
  totalTokens: number;
}

const speakersPath = (dir: string, id: string) => path.join(dir, `${id}.speakers.json`);
const progressPath = (job: Job) => path.join(job.folder, `${job.id}.mono-progress.json`);
const final = (reason: FailureReason): StepOutcome => ({ ok: false, retryable: false, reason });

export async function readSpeakersFile(dir: string, id: string): Promise<SpeakersFile | null> {
  try {
    const f = JSON.parse(await readFile(speakersPath(dir, id), "utf8")) as SpeakersFile;
    return f && f.version === 1 && Array.isArray(f.chunks) && Array.isArray(f.turns) && Array.isArray(f.flips) ? f : null;
  } catch {
    return null;
  }
}

async function loadCheckpoint(job: Job, model: string): Promise<MonoCheckpoint> {
  try {
    const c = JSON.parse(await readFile(progressPath(job), "utf8")) as MonoCheckpoint;
    if (c.version === 1 && c.model === model && c.done && typeof c.done === "object") return c;
  } catch { /* none yet, or damaged: start over */ }
  return { version: 1, model, done: {}, requests: 0, totalTokens: 0 };
}

export async function transcribeMonoJob(deps: MonoDeps, job: Job): Promise<StepOutcome> {
  const apiKey = await deps.getGeminiKey();
  if (!apiKey || !apiKey.trim()) return final("no_gemini_key");
  const reader = await deps.openMono(job);
  if (!reader) return final("audio_missing");
  try {
    return await transcribeChunks(deps, job, apiKey, reader);
  } finally {
    await reader.close?.().catch(() => undefined);
  }
}

async function transcribeChunks(deps: MonoDeps, job: Job, apiKey: string, reader: PcmReader): Promise<StepOutcome> {
  const sr = MONO_SAMPLE_RATE;
  const model = deps.getModel();
  const checkpoint = await loadCheckpoint(job, model);
  const chunks: Chunk[] = planChunks((reader.length / sr) * 1000);
  let unclear = 0;
  for (const c of chunks) {
    if (String(c.index) in checkpoint.done) continue;
    const a = Math.round((c.start_ms / 1000) * sr);
    const b = Math.max(a, Math.min(reader.length, Math.round((c.end_ms / 1000) * sr)));
    const wav = encodeWav(await reader.read(a, b - a), sr);
    const r = await transcribeSegment(deps.gemini, { apiKey, model, wav, prompt: DIARIZE_PROMPT });
    if (r.ok) {
      checkpoint.done[String(c.index)] = r.text;
      checkpoint.requests++;
      checkpoint.totalTokens += r.usage.totalTokens;
    } else if (r.kind === "blocked" || r.kind === "too_large") {
      checkpoint.done[String(c.index)] = "";
    } else if (r.kind === "retry_exhausted") {
      return { ok: false, retryable: true, retryAfterMs: r.retryAfterMs };
    } else if (r.kind === "no_key") {
      return final("no_gemini_key");
    } else if (r.kind === "key_rejected") {
      return final("gemini_key_rejected");
    } else if (r.kind === "model_not_found" || r.kind === "bad_model") {
      return final("gemini_model_not_found");
    } else {
      unclear++; // a 400 for this chunk: not checkpointed, so a retry asks again
      continue;
    }
    await writeFileAtomic(progressPath(job), JSON.stringify(checkpoint));
  }
  if (unclear > 0 && unclear * 2 >= chunks.length) return final("gemini_bad_request");

  const perChunk = chunks.map((c) => parseLabelledTurns(checkpoint.done[String(c.index)] ?? "", c.start_ms, c.end_ms));
  const file: SpeakersFile = {
    version: 1,
    model,
    chunks,
    flips: alignChunks(perChunk),
    turns: mergeChunkTurns(chunks.map((c, i) => ({ ...c, turns: perChunk[i] }))),
    requests: checkpoint.requests,
    totalTokens: checkpoint.totalTokens,
  };
  await writeFileAtomic(speakersPath(job.folder, job.id), JSON.stringify(file));
  await rm(progressPath(job), { force: true });
  return { ok: true, needsSpeakers: true };
}

const isLetter = (v: unknown): v is "A" | "B" => v === "A" || v === "B";

/** The TA's choice → the call's `.transcript.json` / `.md` with ta / candidate (then it is sent as usual). */
export async function writeChosenTranscript(deps: { appVersion: string }, job: Job, choice: SpeakerChoice): Promise<void> {
  if (!isLetter(choice?.me) || !Array.isArray(choice.swapped) || !choice.swapped.every((n) => Number.isInteger(n) && n >= 0)) {
    throw new Error("bad speaker choice");
  }
  const s = await readSpeakersFile(job.folder, job.id);
  if (!s) throw new Error("no speakers file");
  const turns = applySpeakers(s.turns, choice).map((t) => ({ ...t, text: sanitiseTurnText(t.text) })).filter((t) => t.text !== "");
  const file = buildTranscriptFile({
    sessionId: job.sessionId,
    dialMode: job.dialMode,
    startedAtMs: Date.parse(job.startedAt),
    endedAtMs: Date.parse(job.endedAt),
    tzOffsetMinutes: isoOffsetMinutes(job.startedAt),
    turns,
    model: s.model,
    appVersion: deps.appVersion,
  });
  await writeTranscriptFiles(job.folder, job.id, file, { requests: s.requests, totalTokens: s.totalTokens });
}
