// The "Recent calls" list in the recorder window: one row per queued call, in plain words.
// No candidate names (the app does not know them, D-30) and no folder paths go to the window.
import type { FailureReason, Job } from "../core";

export interface CallRow {
  id: string;
  /** ISO with the zone, as recorded. */
  startedAt: string;
  durationS: number;
  linked: boolean;
  stage: "Recorded" | "Transcribing" | "Transcribed" | "Sending" | "Sent" | "Failed";
  /** A second line: why it failed, what it waits for, or "Local only". */
  detail: string | null;
  canRetry: boolean;
  hasTranscript: boolean;
}

const REASONS: Record<FailureReason, string> = {
  no_gemini_key: "Add a Gemini key in Settings to transcribe.",
  gemini_key_rejected: "Gemini refused the key. Check the Gemini key in Settings, then press Retry.",
  gemini_model_not_found: "Gemini does not know this model. Check the model name in Settings, then press Retry.",
  gemini_bad_request: "Gemini could not transcribe this call. Press Retry; if it fails again, take notes by hand.",
  audio_missing: "The recording files are missing, so there is nothing to transcribe.",
  no_solace_address: "The Solace address is not set or cannot be used. Fix it in Settings, then press Retry.",
  upload_ticket_missing: "The app lost Solace's permission to send this call. Take notes by hand in Solace.",
  upload_window_closed: "The 72-hour window to send this call to Solace has closed. Take notes by hand in Solace.",
  transcript_missing: "The transcript file is missing. Press Retry to transcribe again.",
  solace_refused: "Solace did not accept this transcript (permission expired or already used). Take notes by hand in Solace.",
  solace_invalid: "Solace said the transcript is not valid. Tell the app owner; take notes by hand in Solace.",
  solace_different_content: "Solace already has a different transcript for this call. Nothing was overwritten.",
  transcript_too_large: "The transcript is too large for Solace. Tell the app owner; take notes by hand in Solace.",
  app_bug: "Something went wrong inside the app. Tell the app owner.",
  unexpected_error: "Something went wrong several times in a row. Press Retry later.",
};

export function reasonText(r: FailureReason): string {
  return REASONS[r] ?? REASONS.unexpected_error;
}

const LABEL: Record<Exclude<Job["stage"], "failed" | "local_only">, CallRow["stage"]> = {
  recorded: "Recorded",
  transcribing: "Transcribing",
  transcribed: "Transcribed",
  sending: "Sending",
  sent: "Sent",
};

const LOCAL_ONLY = "Local only — not linked to Solace";

function row(j: Job, o: { hasKey: boolean; transcriptIds: ReadonlySet<string> }): CallRow {
  const linked = j.sessionId !== null;
  const started = Date.parse(j.startedAt);
  const ended = Date.parse(j.endedAt);
  const durationS = Number.isNaN(started) || Number.isNaN(ended) ? 0 : Math.max(0, Math.round((ended - started) / 1000));
  const base = { id: j.id, startedAt: j.startedAt, durationS, linked, hasTranscript: o.transcriptIds.has(j.id), canRetry: false };

  if (j.stage === "failed") {
    return { ...base, stage: "Failed", detail: reasonText(j.failure?.reason ?? "unexpected_error"), canRetry: true };
  }
  if (j.stage === "local_only") return { ...base, stage: "Transcribed", detail: LOCAL_ONLY };
  let detail: string | null = linked ? null : LOCAL_ONLY;
  if (j.stage === "recorded" && !o.hasKey) detail = "Add a Gemini key in Settings to transcribe";
  else if ((j.stage === "recorded" || j.stage === "transcribed") && j.nextAttemptAt) detail = "Waiting to try again (network or service busy)";
  return { ...base, stage: LABEL[j.stage], detail };
}

/** Newest first. */
export function callRows(jobs: Job[], o: { hasKey: boolean; transcriptIds: ReadonlySet<string> }): CallRow[] {
  return jobs
    .map((j) => row(j, o))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}
