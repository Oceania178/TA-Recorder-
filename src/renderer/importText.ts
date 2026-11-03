// D-171 "Import a recording": the words and button states of the import, as plain functions (tested).
import type { ImportLayout, RecorderState } from "../main/ipcTypes";

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

export function importDone(r: { audio: "stereo" | "mono"; fromFileTime: boolean; sameOnBoth?: boolean }, linked: boolean): string {
  const same = r.sameOnBoth ? " Both channels carried the same sound, so it is treated as mixed." : "";
  const time = (r.fromFileTime ? "" : " The file's own time could not be used, so the import time is the call's time.") + same;
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

/**
 * Review R3 I3: a two-channel file is read as TA-left / candidate-right only when the TA says so. The question's
 * default is "both voices mixed" unless the file has the name of one of this app's own recordings.
 */
export function layoutDefault(looksLikeAppFile: boolean): ImportLayout {
  return looksLikeAppFile ? "left-ta" : "mixed";
}

export function layoutHint(looksLikeAppFile: boolean): string {
  return looksLikeAppFile
    ? "The file name looks like a TA Call Recorder recording."
    : 'Not sure? Choose "No, both voices are mixed": Gemini then tells the two voices apart, and you check them before anything is sent.';
}

/** Review R3-2 f5: a file was picked during a live Solace call, but the call ended (and was saved) before Import. */
export const LIVE_ENDED_MESSAGE = "The live call ended before you pressed Import. It was saved and is transcribed and sent to Solace as usual. Nothing was imported.";

export function liveEndedBeforeImport(pick: { forLive: boolean }, liveNow: boolean): boolean {
  return pick.forLive && !liveNow;
}
