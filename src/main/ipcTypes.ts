// Types shared by main, preload and renderer. No Electron or Node imports here.
export type Track = "stereo" | "left" | "right";
export type RecorderState = "idle" | "starting" | "recording" | "paused" | "stopping";
export type Command = "start" | "stop" | "pause" | "resume";

export interface MicProcessing {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export type BeginResult = { ok: true; callId: string } | { ok: false; message: string };
export type EndResult = { ok: true; callId: string } | { ok: false; message: string };

export interface StatusReport {
  state: RecorderState;
  elapsedMs: number;
  /** Meter levels 0..1: [left = you, right = other side]. */
  levels: [number, number];
  warning: string | null;
}

export interface SettingsView {
  recordingsDir: string;
  dirProblem: string | null;
  micProcessing: boolean;
  shortcuts: { toggleRecord: string; togglePause: string };
  /** One-off messages for the window, e.g. "Recovered 1 recording". */
  notices: string[];
}

/** The narrow API the preload exposes as window.recorderApi. */
export interface RecorderApi {
  beginCall(micProcessing: MicProcessing): Promise<BeginResult>;
  appendChunk(callId: string, track: Track, data: ArrayBuffer): Promise<void>;
  markPause(callId: string, kind: "pause" | "resume", recordedMs: number): Promise<void>;
  endCall(callId: string, recordedMs: number): Promise<EndResult>;
  abortCall(callId: string): Promise<void>;
  reportStatus(status: StatusReport): void;
  rendererReady(): void;
  getSettings(): Promise<SettingsView>;
  chooseRecordingsDir(): Promise<SettingsView>;
  setMicProcessing(on: boolean): Promise<SettingsView>;
  openRecordingsFolder(): Promise<void>;
  /** Floating bar buttons. */
  sendBarCommand(command: Command | "open"): void;
  /** Floating bar display. */
  onStatus(listener: (status: StatusReport) => void): void;
}

export const IPC = {
  beginCall: "call:begin",
  appendChunk: "call:chunk",
  markPause: "call:pause-mark",
  endCall: "call:end",
  abortCall: "call:abort",
  status: "recorder:status",
  ready: "recorder:ready",
  getSettings: "settings:get",
  chooseDir: "settings:choose-dir",
  setMicProcessing: "settings:mic-processing",
  openFolder: "recordings:open-folder",
  barCommand: "bar:command",
  statusToBar: "bar:status",
} as const;
