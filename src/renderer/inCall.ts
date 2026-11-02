// P1 (UX round 2): while a call is recorded, paused or being saved, the window folds Recent calls, Device check
// and Settings away; the timer, meters, Pause / Stop, the Solace / Local only label and every warning stay.
import type { RecorderState } from "../main/ipcTypes";

export function isInCall(state: RecorderState): boolean {
  return state === "recording" || state === "paused" || state === "stopping";
}
