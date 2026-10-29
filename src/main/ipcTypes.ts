// Types shared by main, preload and renderer. No Electron or Node imports here.
export type Track = "stereo" | "left" | "right";
export type RecorderState = "idle" | "starting" | "recording" | "paused" | "stopping";
export type Command = "start" | "stop" | "pause" | "resume";

export interface MicProcessing {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

/** linked = a Solace session started this call (Step 5); otherwise it is local only, never sent (D-82). */
export type BeginResult = { ok: true; callId: string; linked: boolean; dialMode: "3cx" | "self_dial" | null } | { ok: false; message: string };
export type EndResult = { ok: true; callId: string } | { ok: false; message: string };

export interface StatusReport {
  state: RecorderState;
  elapsedMs: number;
  /** Meter levels 0..1: [left = you, right = other side]. */
  levels: [number, number];
  warning: string | null;
}

/** What the recorder controller knows (folder, mic, shortcuts, notices). */
export interface BaseSettingsView {
  recordingsDir: string;
  dirProblem: string | null;
  micProcessing: boolean;
  shortcuts: { toggleRecord: string; togglePause: string };
  /** One-off messages for the window, e.g. "Recovered 1 recording". */
  notices: string[];
}

/** The whole Settings panel. Never the Gemini key itself: only its last 4 characters (keyHint). */
export interface SettingsView extends BaseSettingsView {
  solaceBaseUrl: string | null;
  geminiModel: string;
  geminiModelIsDefault: boolean;
  /** "•••• wxyz", or null when no key is set. */
  geminiKeyHint: string | null;
  /** False when Windows secure storage is not available: a key cannot be saved. */
  keyStorageOk: boolean;
  /** A --dev build (http://localhost allowed as the Solace address). */
  dev: boolean;
  noticeAccepted: boolean;
  wizardDone: boolean;
}

/** Answer to a settings change: a plain-words problem (null = saved) and the panel as it is now. */
export interface SettingsChange {
  problem: string | null;
  view: SettingsView;
}

export interface AddressTestView {
  ok: boolean;
  level: "solace" | "https_only" | "invalid" | "unreachable";
  message: string;
}

/** One row of "Recent calls" (see callsView.ts). No folder path, no candidate name. */
export interface CallRowView {
  id: string;
  startedAt: string;
  durationS: number;
  linked: boolean;
  stage: "Recorded" | "Transcribing" | "Transcribed" | "Sending" | "Sent" | "Failed";
  detail: string | null;
  canRetry: boolean;
  hasTranscript: boolean;
}

/** A message from main for the recorder window (e.g. why a Solace link did not start a recording). */
export interface AppMessage {
  kind: "info" | "error" | "ok";
  text: string;
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
  // Settings (Step 2 / Step 5)
  setSolaceAddress(raw: string): Promise<SettingsChange>;
  testSolaceAddress(raw: string): Promise<AddressTestView>;
  setGeminiKey(raw: string): Promise<SettingsChange>;
  clearGeminiKey(): Promise<SettingsView>;
  setGeminiModel(raw: string): Promise<SettingsChange>;
  // Recent calls
  listCalls(): Promise<CallRowView[]>;
  retryCall(id: string): Promise<void>;
  openCallFolder(id: string): Promise<void>;
  openTranscript(id: string): Promise<boolean>;
  onCallsChanged(listener: () => void): void;
  // First-run wizard (D-132)
  acceptNotice(): Promise<SettingsView>;
  finishWizard(): Promise<SettingsView>;
  openMicSettings(): Promise<void>;
  testDial(phoneNumber: string): Promise<boolean>;
  onShowWizard(listener: () => void): void;
  onAppMessage(listener: (message: AppMessage) => void): void;
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
  setSolaceAddress: "settings:solace-address",
  testSolaceAddress: "settings:test-solace-address",
  setGeminiKey: "settings:gemini-key",
  clearGeminiKey: "settings:clear-gemini-key",
  setGeminiModel: "settings:gemini-model",
  listCalls: "calls:list",
  retryCall: "calls:retry",
  openCallFolder: "calls:open-folder",
  openTranscript: "calls:open-transcript",
  callsChanged: "calls:changed",
  acceptNotice: "wizard:accept-notice",
  finishWizard: "wizard:finish",
  openMicSettings: "wizard:open-mic-settings",
  testDial: "wizard:test-dial",
  showWizard: "wizard:show",
  appMessage: "app:message",
  decoderRequest: "decoder:request",
  decoderReply: "decoder:reply",
} as const;
