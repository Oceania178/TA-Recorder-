// The tray menu as plain data (tray.ts turns it into Electron's menu). P4 (UX round 2): a line with the last
// call's stage and "Open last transcript". No Test mode switch here, on purpose: no local recording by accident.
import { callTime } from "./callOutcomes";
import type { CallRow } from "./callsView";
import type { RecorderState } from "./ipcTypes";
import { SHORTCUTS } from "./shortcuts";

export interface LastCall {
  line: string;
  /** The newest call whose transcript file exists; null when none. */
  transcriptId: string | null;
}

export type TrayAction = "start" | "pauseOrResume" | "stop" | "open" | "settings" | "wizard" | "openLastTranscript" | "quit";
export type TrayItem = { type: "separator" } | { label: string; enabled: boolean; action?: TrayAction };

/** Rows newest first, as Recent calls shows them. */
export function lastCall(rows: readonly CallRow[]): LastCall {
  const newest = rows[0];
  if (!newest) return { line: "No calls yet", transcriptId: null };
  const stage = newest.stage === "Transcribed" && !newest.linked ? "Transcribed, Local only" : newest.stage;
  const time = callTime(newest.startedAt);
  return { line: `Last call${time ? ` (${time})` : ""}: ${stage}`, transcriptId: rows.find((r) => r.hasTranscript)?.id ?? null };
}

export function trayMenuItems(state: RecorderState, last: LastCall): TrayItem[] {
  const active = state === "recording" || state === "paused";
  return [
    { label: `Start recording (${SHORTCUTS.toggleRecord.label})`, enabled: state === "idle", action: "start" },
    { label: `${state === "paused" ? "Resume" : "Pause"} (${SHORTCUTS.togglePause.label})`, enabled: active, action: "pauseOrResume" },
    { label: `Stop and save (${SHORTCUTS.toggleRecord.label})`, enabled: active, action: "stop" },
    { type: "separator" },
    { label: last.line, enabled: false },
    { label: "Open last transcript", enabled: last.transcriptId !== null, action: "openLastTranscript" },
    { type: "separator" },
    { label: "Open recorder", enabled: true, action: "open" },
    { label: "Settings", enabled: true, action: "settings" },
    { label: "Set-up check…", enabled: state === "idle", action: "wizard" },
    { type: "separator" },
    { label: "Quit", enabled: true, action: "quit" },
  ];
}
