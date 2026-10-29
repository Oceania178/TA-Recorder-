// core/pipeline.ts — the two queue steps for one call, every dependency injected (spec §2 steps 5–7, §5.1
// option B; D-15, D-82, D-85, D-139, D-141):
//
// transcribeJob (recorded → transcribed):
//   decoded left + right PCM → VAD per channel → each stretch as a 16 kHz WAV → Gemini, one request at a
//   time → turns (left = ta, right = candidate) → `<id>.transcript.json` + `.md` in the call's folder.
//   Finished segments are kept in a checkpoint (`<id>.progress.json`, same folder, deleted with it by
//   retention) so a restart or a network outage never pays twice for the same audio.
// sendJob (transcribed → sent):
//   read the `.transcript.json`, turn it into the §8.24 payload and upload it to the pinned Solace address
//   with the upload ticket. A resend is the same body (D-85). Solace's answers become queue outcomes.
//
// The audio never leaves the laptop except as inline segments to Gemini (D-139); Solace gets text only.
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomicWrite";
import { transcribeSegment, type GeminiDeps } from "./gemini";
import type { FailureReason, Job, SendOutcome, StepOutcome } from "./queue";
import { uploadTranscript, type SolaceDeps } from "./solaceClient";
import { assembleTurns, buildTranscriptFile, readTranscriptFile, toPayload, writeTranscriptFiles, type ChannelText } from "./transcript";
import { detectSpeech, type VadOptions } from "./vad";
import { encodeWav, slicePcm } from "./wav";

export interface DecodedCall {
  /** The TA's mic. */
  left: Float32Array;
  /** The other side (loopback). */
  right: Float32Array;
  sampleRate: number;
}

export interface PipelineDeps {
  /** Decode the call's left-only and right-only files (renderer / OfflineAudioContext); null if missing. */
  loadPcm(job: Job): Promise<DecodedCall | null>;
  /** From safeStorage, at the moment of use; never stored by the core (D-141). */
  getGeminiKey(): Promise<string | null>;
  getModel(): string;
  gemini: GeminiDeps;
  appVersion: string;
  vad?: Partial<VadOptions>;
}

export interface SendDeps {
  solace: SolaceDeps;
  /** The pinned Solace origin (settings), or null before the first-run wizard set it. */
  getBaseUrl(): string | null;
}

type Channel = "L" | "R";

interface Checkpoint {
  version: 1;
  model: string;
  /** `L:1000-2500` → text, for every segment already transcribed. */
  done: Record<string, string>;
  requests: number;
  totalTokens: number;
}

const progressPath = (job: Job) => path.join(job.folder, `${job.id}.progress.json`);

async function loadCheckpoint(job: Job, model: string): Promise<Checkpoint> {
  try {
    const c = JSON.parse(await readFile(progressPath(job), "utf8")) as Checkpoint;
    if (c.version === 1 && c.model === model && c.done && typeof c.done === "object") return c;
  } catch { /* none yet, or damaged: start over */ }
  return { version: 1, model, done: {}, requests: 0, totalTokens: 0 };
}

/** Minutes east of UTC from an ISO string's zone (`Z`, `+07:00`); 0 when there is none. */
export function isoOffsetMinutes(iso: string): number {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (!m) return 0;
  const v = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -v : v;
}

const final = (reason: FailureReason): StepOutcome => ({ ok: false, retryable: false, reason });

export async function transcribeJob(deps: PipelineDeps, job: Job): Promise<StepOutcome> {
  const apiKey = await deps.getGeminiKey();
  if (!apiKey || !apiKey.trim()) return final("no_gemini_key");
  const pcm = await deps.loadPcm(job);
  if (!pcm) return final("audio_missing");

  const model = deps.getModel();
  const checkpoint = await loadCheckpoint(job, model);
  const texts: Record<Channel, ChannelText[]> = { L: [], R: [] };

  for (const ch of ["L", "R"] as const) {
    const signal = ch === "L" ? pcm.left : pcm.right;
    for (const seg of detectSpeech(signal, pcm.sampleRate, deps.vad)) {
      const key = `${ch}:${seg.start_ms}-${seg.end_ms}`;
      if (!(key in checkpoint.done)) {
        const wav = encodeWav(slicePcm(signal, pcm.sampleRate, seg.start_ms, seg.end_ms), pcm.sampleRate);
        const r = await transcribeSegment(deps.gemini, { apiKey, model, wav });
        if (r.ok) {
          checkpoint.done[key] = r.text;
          checkpoint.requests++;
          checkpoint.totalTokens += r.usage.totalTokens;
        } else if (r.kind === "blocked" || r.kind === "too_large") {
          checkpoint.done[key] = ""; // this stretch cannot be transcribed; the rest of the call still is
        } else if (r.kind === "retry_exhausted") {
          return { ok: false, retryable: true, retryAfterMs: r.retryAfterMs };
        } else if (r.kind === "no_key") {
          return final("no_gemini_key");
        } else if (r.kind === "key_rejected") {
          return final("gemini_key_rejected");
        } else if (r.kind === "model_not_found" || r.kind === "bad_model") {
          return final("gemini_model_not_found");
        } else {
          return final("gemini_bad_request");
        }
        await writeFileAtomic(progressPath(job), JSON.stringify(checkpoint));
      }
      texts[ch].push({ start_ms: seg.start_ms, end_ms: seg.end_ms, text: checkpoint.done[key] });
    }
  }

  const file = buildTranscriptFile({
    sessionId: job.sessionId,
    dialMode: job.dialMode,
    startedAtMs: Date.parse(job.startedAt),
    endedAtMs: Date.parse(job.endedAt),
    tzOffsetMinutes: isoOffsetMinutes(job.startedAt),
    turns: assembleTurns(texts.L, texts.R),
    model,
    appVersion: deps.appVersion,
  });
  await writeTranscriptFiles(job.folder, job.id, file, { requests: checkpoint.requests, totalTokens: checkpoint.totalTokens });
  await rm(progressPath(job), { force: true });
  return { ok: true };
}

export async function sendJob(deps: SendDeps, job: Job, uploadTicket: string): Promise<SendOutcome> {
  const baseUrl = deps.getBaseUrl();
  if (!baseUrl) return { ok: false, retryable: false, reason: "no_solace_address" };
  const file = await readTranscriptFile(job.folder, job.id);
  if (!file) return { ok: false, retryable: false, reason: "transcript_missing" };
  const payload = toPayload(file);
  if (!payload || payload.session_id !== job.sessionId) return { ok: false, retryable: false, reason: "app_bug" };

  const r = await uploadTranscript(deps.solace, baseUrl, uploadTicket, payload);
  if (r.ok) return { ok: true, callId: r.callId, duplicate: r.duplicate };
  switch (r.kind) {
    case "different_content": return { ok: false, retryable: false, reason: "solace_different_content" };
    case "refused": return { ok: false, retryable: false, reason: "solace_refused" };
    case "invalid": return { ok: false, retryable: false, reason: "solace_invalid", details: r.reasons };
    case "too_large": return { ok: false, retryable: false, reason: "transcript_too_large" };
    case "not_json": return { ok: false, retryable: false, reason: "app_bug" };
    case "bad_address": return { ok: false, retryable: false, reason: "no_solace_address" };
    case "retryable": return { ok: false, retryable: true, retryAfterMs: r.retryAfterMs };
    case "unexpected": return { ok: false, retryable: true, retryAfterMs: null };
  }
}
