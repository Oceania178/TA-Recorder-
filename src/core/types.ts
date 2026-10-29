// core/types.ts — the shapes shared by the core modules (spec v1.22 §8.24, D-142, schema_version 1).
// Plain data only; no Electron, no Node imports.

/** How the TA dials (D-133): 3CX opened by Solace, or the TA calls with another app. */
export type DialMode = "3cx" | "self_dial";
export const DIAL_MODES: readonly DialMode[] = ["3cx", "self_dial"];
export const isDialMode = (v: unknown): v is DialMode => v === "3cx" || v === "self_dial";

/** Left channel = the TA's mic, right channel = the other side (loopback). */
export type Speaker = "ta" | "candidate";

/** A stretch of speech found by the VAD, in milliseconds from the start of the recording. */
export interface SpeechSegment {
  start_ms: number;
  end_ms: number;
}

/** One turn in the transcript (§8.24 `transcript.segments[]`). */
export interface Turn {
  speaker: Speaker;
  start_ms: number;
  end_ms: number;
  text: string;
}

/** The §8.24 ② body, exactly — nothing else is ever sent (D-139: no file, no audio, no key, no candidate data). */
export interface TranscriptPayload {
  schema_version: 1;
  session_id: string;
  call: {
    started_at: string;
    ended_at: string;
    duration_s: number;
    dial_mode: DialMode;
    has_content: boolean;
  };
  transcript: {
    segments: Turn[];
    model: string;
  };
  recorder: {
    app_version: string;
  };
}
