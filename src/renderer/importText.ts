// D-171 "Import a recording": the words and button states of the import, as plain functions (tested).
import type { RecorderState } from "../main/ipcTypes";

/**
 * Idle: shown only in Test mode (an import without Solace is Local only, D-165). During a Solace call
 * (`linked`): "Import a recording instead…" replaces the live recording. Never during a Local only recording.
 */
export function importButton(state: RecorderState, linked: boolean | null, testMode: boolean): { visible: boolean; label: string; enabled: boolean } {
  const live = state === "recording" || state === "paused";
  if (live || state === "starting" || state === "stopping") {
    return { visible: linked === true, label: "Import a recording instead…", enabled: live };
  }
  return { visible: testMode, label: "Import a recording…", enabled: true };
}

export function importDone(r: { audio: "stereo" | "mono"; fromFileTime: boolean }, linked: boolean): string {
  const time = r.fromFileTime ? "" : " The file's own time could not be used, so the import time is the call's time.";
  if (r.audio === "mono") {
    return linked
      ? `Imported. Gemini now tells the two voices apart; then choose which one is yours, and it is sent to Solace.${time}`
      : `Imported (Local only — never sent). Gemini now tells the two voices apart; then choose which one is yours.${time}`;
  }
  return linked
    ? `Imported. It is transcribed next and sent to Solace — see Recent calls.${time}`
    : `Imported (Local only — never sent). It is transcribed next — see Recent calls.${time}`;
}

export function speakerSendLabel(linked: boolean): string {
  return linked ? "Send to Solace" : "Save the transcript";
}
