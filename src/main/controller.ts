// The recorder's brain in the main process: one call at a time (D-39), files on disk (R6), settings.
// Plain Node only (no Electron import) so the flow can be reasoned about apart from windows and tray.
import { join } from "node:path";
import { loadSettings, saveSettings, type AppSettings } from "./appSettings";
import { isTrack } from "./callFiles";
import { isValidCallId, makeCallId } from "./callId";
import { CallWriter } from "./chunkStore";
import type { BeginResult, EndResult, MicProcessing, RecorderState, SettingsView } from "./ipcTypes";
import { checkRecordingsDir, defaultRecordingsDir } from "./recordingsFolder";
import { recoverLeftovers } from "./recovery";
import { SessionGuard } from "./sessionGuard";
import { SHORTCUTS } from "./shortcuts";

/** 1 s of 32 kbps Opus is ~4 KB; anything near this cap is not a recorder chunk. */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

export interface ControllerDeps {
  userDataDir: string;
  documentsDir: string;
  env: Record<string, string | undefined>;
  appVersion: string;
  onStateChange: (state: RecorderState) => void;
}

export class RecorderController {
  readonly guard = new SessionGuard();
  private writer: CallWriter | null = null;
  private settings: AppSettings = { recordingsDir: null, micProcessing: false };
  private notices: string[] = [];

  constructor(private readonly deps: ControllerDeps) {}

  private get settingsFile(): string {
    return join(this.deps.userDataDir, "settings.json");
  }

  async init(): Promise<void> {
    this.settings = await loadSettings(this.settingsFile);
    await this.recover();
  }

  recordingsDir(): string {
    return this.settings.recordingsDir ?? defaultRecordingsDir(this.deps.documentsDir);
  }

  dirProblem(): string | null {
    const check = checkRecordingsDir(this.recordingsDir(), this.deps.env);
    return check.ok ? null : check.message;
  }

  /** R6: finish any call a crash left behind. Counts only; never names a candidate (there is none to name). */
  async recover(): Promise<void> {
    if (this.dirProblem()) return;
    const r = await recoverLeftovers(this.recordingsDir(), { skipCallId: this.writer?.callId });
    if (r.recovered.length > 0) {
      this.notices.push(
        `Recovered ${r.recovered.length} recording(s) after an unexpected stop: ${r.recovered.map((x) => x.callId).join(", ")}. They are marked "recovered".`,
      );
    }
    if (r.failed.length > 0) this.notices.push(`${r.failed.length} unfinished recording(s) could not be recovered and were left in the ".in-progress" folder.`);
  }

  /** A one-off message for the recorder window (shown next time it asks for settings). */
  addNotice(message: string): void {
    this.notices.push(message);
  }

  settingsView(): SettingsView {
    const notices = this.notices;
    this.notices = [];
    return {
      recordingsDir: this.recordingsDir(),
      dirProblem: this.dirProblem(),
      micProcessing: this.settings.micProcessing,
      shortcuts: { toggleRecord: SHORTCUTS.toggleRecord.label, togglePause: SHORTCUTS.togglePause.label },
      notices,
    };
  }

  /** Returns a message when the folder is refused (e.g. OneDrive), null when saved. */
  async setRecordingsDir(dir: string): Promise<string | null> {
    if (this.guard.isActive) return "You can change the folder after this recording stops.";
    const check = checkRecordingsDir(dir, this.deps.env);
    if (!check.ok) return check.message;
    this.settings = { ...this.settings, recordingsDir: dir };
    await saveSettings(this.settingsFile, this.settings);
    await this.recover();
    return null;
  }

  async setMicProcessing(on: boolean): Promise<void> {
    if (this.guard.isActive) return;
    this.settings = { ...this.settings, micProcessing: on };
    await saveSettings(this.settingsFile, this.settings);
  }

  private changed(): void {
    this.deps.onStateChange(this.guard.state);
  }

  async beginCall(mic: MicProcessing): Promise<BeginResult> {
    const check = this.guard.tryBegin();
    if (!check.ok) return check;
    const problem = this.dirProblem();
    if (problem) {
      this.guard.ended();
      return { ok: false, message: problem };
    }
    const callId = makeCallId(new Date());
    try {
      this.writer = await CallWriter.begin({ root: this.recordingsDir(), callId, startedAt: new Date(), micProcessing: mic, appVersion: this.deps.appVersion });
      // Still "starting": opening the mic and system audio takes 1-2 s. The page reports when audio flows.
      this.changed();
      return { ok: true, callId };
    } catch {
      this.writer = null;
      this.guard.ended();
      this.changed();
      return { ok: false, message: "Could not create the recording files. Check that the recordings folder exists and can be written to." };
    }
  }

  private writerFor(callId: unknown): CallWriter | null {
    if (typeof callId !== "string" || !isValidCallId(callId)) return null;
    return this.writer && this.writer.callId === callId ? this.writer : null;
  }

  async appendChunk(callId: unknown, track: unknown, data: unknown): Promise<void> {
    const w = this.writerFor(callId);
    if (!w || !isTrack(track)) throw new Error("Chunk refused: no such recording");
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) throw new Error("Chunk refused: not audio bytes");
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.byteLength > MAX_CHUNK_BYTES) throw new Error("Chunk refused: too large");
    await w.append(track, bytes);
  }

  async markPause(callId: unknown, kind: unknown, recordedMs: unknown): Promise<void> {
    const w = this.writerFor(callId);
    if (!w || (kind !== "pause" && kind !== "resume") || typeof recordedMs !== "number") return;
    if (kind === "pause") this.guard.paused();
    else this.guard.resumed();
    this.changed();
    await w.markPause({ kind, at: new Date(), recordedMs });
  }

  /** The page has opened the mic and system audio and its recorders run: now the call is "recording". */
  noteCaptureStarted(): void {
    if (this.guard.state === "starting" && this.writer) {
      this.guard.started(this.writer.callId);
      this.changed();
    }
  }

  /** The renderer told us it is stopping its recorders (for the tray and floating bar). */
  noteStopping(): void {
    if (this.guard.state === "recording" || this.guard.state === "paused") {
      this.guard.stopping();
      this.changed();
    }
  }

  async endCall(callId: unknown, recordedMs: unknown): Promise<EndResult> {
    const w = this.writerFor(callId);
    if (!w) return { ok: false, message: "No recording with this id is running." };
    this.guard.stopping();
    this.changed();
    try {
      await w.finalise({ endedAt: new Date(), recordedMs: typeof recordedMs === "number" ? recordedMs : 0 });
      return { ok: true, callId: w.callId };
    } catch {
      return { ok: false, message: 'The recording could not be moved to its final name. It stays in the ".in-progress" folder and will be recovered at the next start.' };
    } finally {
      this.writer = null;
      this.guard.ended();
      this.changed();
    }
  }

  async abortCall(callId: unknown): Promise<void> {
    const w = this.writerFor(callId);
    if (!w) return;
    this.writer = null;
    try {
      await w.abort();
    } finally {
      this.guard.ended();
      this.changed();
    }
  }

  /** R6: the recorder page crashed mid-call. Keep what reached the disk and mark it recovered. */
  async recorderLost(): Promise<void> {
    const w = this.writer;
    if (!w) return;
    this.writer = null;
    try {
      await w.flush();
    } catch {
      // whatever is on disk is what we keep
    }
    this.guard.ended();
    this.changed();
    await this.recover();
  }

  get activeCallId(): string | null {
    return this.writer?.callId ?? null;
  }
}
