// core/limits.ts — Solace's hard caps on one upload (Solace contract.ts: MAX_SEGMENTS, MAX_TOTAL_CHARS; its
// text rules are already met by transcript.ts sanitiseTurnText). Checked before sending (APP review M5):
// Solace refuses an upload over a cap with a final 400, so the app fails it itself, with a clear reason,
// instead of sending a call Solace can never accept.
import type { TranscriptPayload } from "./types";

export const SOLACE_MAX_TURNS = 5_000;
export const SOLACE_MAX_CHARS = 300_000;

/** Plain-words problems ("more than 5,000 turns"), or [] when the payload fits. */
export function solaceLimitProblems(p: TranscriptPayload): string[] {
  const problems: string[] = [];
  if (p.transcript.segments.length > SOLACE_MAX_TURNS) problems.push(`more than ${SOLACE_MAX_TURNS.toLocaleString("en-US")} turns`);
  const chars = p.transcript.segments.reduce((n, s) => n + s.text.length, 0);
  if (chars > SOLACE_MAX_CHARS) problems.push(`more than ${SOLACE_MAX_CHARS.toLocaleString("en-US")} characters`);
  return problems;
}
