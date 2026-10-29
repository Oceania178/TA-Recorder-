// core/transcript.ts — from transcribed segments to the transcript (spec §4, §5, §8.3, §8.24 ②; D-37, D-82,
// D-84, D-142):
// - both channels' segments become turns sorted by time: left = `ta`, right = `candidate` (§5.2);
// - the §8.24 payload (schema_version 1) — and nothing else (D-139);
// - the two files beside the audio, named by the call id (D-84): `<id>.transcript.md` for people and
//   `<id>.transcript.json` for the machine. The JSON is exactly what is (or, for a local-only call, would
//   be) sent; a local-only call (no session, D-82) has `session_id: null` and is never sent.
// Turn text is cleaned so Solace never has to refuse it: one line, no box-drawing characters, no long
// base64-like runs (Solace's contract.ts refusals). Nothing here logs.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomicWrite";
import { isDialMode, type DialMode, type TranscriptPayload, type Turn } from "./types";

/**
 * D-37: a call "has content" when the candidate's channel has at least this many turns with words.
 * The real threshold is not set yet (it comes from Step 3 data); change it here only.
 */
export const HAS_CONTENT_MIN_CANDIDATE_TURNS = 1;

/** A transcribed stretch of one channel. */
export interface ChannelText {
  start_ms: number;
  end_ms: number;
  text: string;
}

/** The `.transcript.json` file: the §8.24 payload, with `session_id` / `dial_mode` null for a local-only call. */
export interface TranscriptFile {
  schema_version: 1;
  session_id: string | null;
  call: {
    started_at: string;
    ended_at: string;
    duration_s: number;
    dial_mode: DialMode | null;
    has_content: boolean;
  };
  transcript: { segments: Turn[]; model: string };
  recorder: { app_version: string };
}

const ch = (c: number) => String.fromCharCode(c);
const LINE_BREAKS = new RegExp(`[${[0x0d, 0x0a, 0x09, 0x0b, 0x0c, 0x85, 0x2028, 0x2029].map(ch).join("")}]+`, "g");
const BOX_DRAWING = new RegExp(`[${ch(0x2500)}-${ch(0x257f)}]+`, "g");
/** Solace refuses a run of more than 200 of these (an encoded blob, D-139). */
const BASE64_RUN = /[A-Za-z0-9+/=_-]{201,}/g;

export function sanitiseTurnText(text: string): string {
  return text
    .replace(LINE_BREAKS, " ")
    .replace(BOX_DRAWING, " ")
    .replace(BASE64_RUN, (run) => (run.match(/.{1,200}/g) ?? [run]).join(" "))
    .replace(/\s+/g, " ")
    .trim();
}

function toTurns(speaker: Turn["speaker"], items: ChannelText[]): Turn[] {
  const out: Turn[] = [];
  for (const s of items) {
    const text = sanitiseTurnText(s.text ?? "");
    if (!text) continue;
    const start = Math.max(0, Math.round(s.start_ms));
    const end = Math.max(start, Math.round(s.end_ms));
    out.push({ speaker, start_ms: start, end_ms: end, text });
  }
  return out;
}

/** Both channels → one list of turns in time order (ties: earlier end first, then the TA). */
export function assembleTurns(left: ChannelText[], right: ChannelText[]): Turn[] {
  const order = { ta: 0, candidate: 1 } as const;
  return [...toTurns("ta", left), ...toTurns("candidate", right)].sort(
    (a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || order[a.speaker] - order[b.speaker],
  );
}

export function hasContent(turns: Turn[]): boolean {
  return turns.filter((t) => t.speaker === "candidate" && t.text.trim() !== "").length >= HAS_CONTENT_MIN_CANDIDATE_TURNS;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `2026-10-26T09:00:00+07:00`: local wall time at the given offset (minutes east of UTC), whole seconds. */
export function formatIsoWithOffset(ms: number, offsetMinutes: number): string {
  const d = new Date(Math.floor(ms / 1000) * 1000 + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

export interface TranscriptInput {
  /** Null for a local-only call (D-82): it is never sent. */
  sessionId: string | null;
  dialMode: DialMode | null;
  startedAtMs: number;
  endedAtMs: number;
  /** Minutes east of UTC, e.g. 420 for Vietnam (`-new Date().getTimezoneOffset()`). */
  tzOffsetMinutes: number;
  turns: Turn[];
  model: string;
  appVersion: string;
}

export function buildTranscriptFile(i: TranscriptInput): TranscriptFile {
  return {
    schema_version: 1,
    session_id: i.sessionId,
    call: {
      started_at: formatIsoWithOffset(i.startedAtMs, i.tzOffsetMinutes),
      ended_at: formatIsoWithOffset(i.endedAtMs, i.tzOffsetMinutes),
      duration_s: Math.max(0, Math.round((i.endedAtMs - i.startedAtMs) / 1000)),
      dial_mode: i.dialMode,
      has_content: hasContent(i.turns),
    },
    transcript: { segments: i.turns.map((t) => ({ ...t })), model: i.model },
    recorder: { app_version: i.appVersion },
  };
}

/** The §8.24 payload to send, or null for a local-only call (no session or dial mode: never sent, D-82). */
export function toPayload(f: TranscriptFile): TranscriptPayload | null {
  if (!f.session_id || !f.call.dial_mode) return null;
  return {
    schema_version: 1,
    session_id: f.session_id,
    call: { ...f.call, dial_mode: f.call.dial_mode },
    transcript: { segments: f.transcript.segments.map((t) => ({ ...t })), model: f.transcript.model },
    recorder: { app_version: f.recorder.app_version },
  };
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = pad2(Math.floor((s % 3600) / 60));
  return h > 0 ? `${h}:${mm}:${pad2(s % 60)}` : `${mm}:${pad2(s % 60)}`;
}

export interface UsageSummary {
  requests: number;
  totalTokens: number;
}

/** The human-readable transcript: a short header, then one paragraph per turn, **TA** [mm:ss] text. */
export function renderMarkdown(f: TranscriptFile, usage?: UsageSummary): string {
  const lines = [
    "# Call transcript",
    "",
    f.session_id ? `- Session: ${f.session_id}` : "- Local only: not linked to a Solace session, never sent (D-82)",
    `- Started: ${f.call.started_at}`,
    `- Ended: ${f.call.ended_at}`,
    `- Duration: ${clock(f.call.duration_s * 1000)}`,
    `- Dial mode: ${f.call.dial_mode === "3cx" ? "3CX" : f.call.dial_mode === "self_dial" ? "self dial" : "—"}`,
    `- Model: ${f.transcript.model}`,
    `- Candidate speech found: ${f.call.has_content ? "yes" : "no"}`,
  ];
  if (usage) lines.push(`- Gemini: ${usage.requests} requests, ${usage.totalTokens} tokens`);
  lines.push("");
  for (const t of f.transcript.segments) {
    lines.push(`**${t.speaker === "ta" ? "TA" : "Candidate"}** [${clock(t.start_ms)}] ${t.text}`, "");
  }
  return lines.join("\n");
}

/** Call ids become file names: letters, digits, `_` and `-` only. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function transcriptPaths(dir: string, id: string): { md: string; json: string } {
  if (!SAFE_ID.test(id)) throw new Error("unsafe call id");
  return { md: path.join(dir, `${id}.transcript.md`), json: path.join(dir, `${id}.transcript.json`) };
}

export async function writeTranscriptFiles(dir: string, id: string, f: TranscriptFile, usage?: UsageSummary): Promise<void> {
  const p = transcriptPaths(dir, id);
  await writeFileAtomic(p.json, `${JSON.stringify(f, null, 2)}\n`);
  await writeFileAtomic(p.md, renderMarkdown(f, usage));
}

const isTurn = (t: unknown): t is Turn => {
  const o = t as Record<string, unknown>;
  return typeof o === "object" && o !== null && (o.speaker === "ta" || o.speaker === "candidate")
    && Number.isInteger(o.start_ms) && Number.isInteger(o.end_ms) && typeof o.text === "string";
};

/** The `.transcript.json` beside the audio, or null when it is missing or not a transcript file. */
export async function readTranscriptFile(dir: string, id: string): Promise<TranscriptFile | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(transcriptPaths(dir, id).json, "utf8"));
  } catch {
    return null;
  }
  const f = raw as TranscriptFile;
  const ok = typeof f === "object" && f !== null && f.schema_version === 1
    && (f.session_id === null || typeof f.session_id === "string")
    && typeof f.call === "object" && f.call !== null
    && typeof f.call.started_at === "string" && typeof f.call.ended_at === "string"
    && typeof f.call.duration_s === "number" && typeof f.call.has_content === "boolean"
    && (f.call.dial_mode === null || isDialMode(f.call.dial_mode))
    && typeof f.transcript === "object" && f.transcript !== null && typeof f.transcript.model === "string"
    && Array.isArray(f.transcript.segments) && f.transcript.segments.every(isTurn)
    && typeof f.recorder === "object" && f.recorder !== null && typeof f.recorder.app_version === "string";
  return ok ? f : null;
}
