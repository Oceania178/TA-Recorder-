// P3 (UX round 2): after Stop the floating bar follows the call it just saved, in plain words, until the call is
// Sent (or, for Local only, transcribed) or the TA closes the bar. Failed offers Retry (the same as Recent calls).
import type { CallRow } from "./callsView";
import { callTime } from "./callOutcomes";
import { NO_KEY_DETAIL } from "./ipcTypes";

export interface BarFollowView {
  title: string;
  text: string;
  /** null until the call is queued. */
  linked: boolean | null;
  /** Sent, or a Local only call transcribed: the bar can go after a few seconds. */
  final: boolean;
  canRetry: boolean;
}

export function followView(r: CallRow | undefined): BarFollowView {
  if (!r) return { title: "Call", text: "Saved", linked: null, final: false, canRetry: false };
  const time = callTime(r.startedAt);
  const base = { title: time ? `Call of ${time}` : "Call", linked: r.linked, final: false, canRetry: false };
  switch (r.stage) {
    case "Recorded":
      return { ...base, text: r.detail === NO_KEY_DETAIL ? "Waiting for a Gemini key (Settings)" : "Saved, transcribing next" };
    case "Transcribing":
      return { ...base, text: "Transcribing…" };
    case "Transcribed":
      if (!r.linked) return { ...base, text: "Transcribed (Local only)", final: true };
      return { ...base, text: r.detail?.startsWith("Waiting to try again") ? "Waiting to send (network busy)" : "Transcribed, sending next" };
    case "Sending":
      return { ...base, text: "Sending to Solace…" };
    case "Sent":
      return { ...base, text: "Sent to Solace", final: true };
    case "Failed":
      return { ...base, text: "Failed — open the recorder to see why", canRetry: r.canRetry };
  }
}
