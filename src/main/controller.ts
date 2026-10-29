// The recorder's brain in the main process: one call at a time (D-39), files on disk (R6), settings.
// Plain Node only (no Electron import) so the flow can be reasoned about apart from windows and tray.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type AppSettings } from "./appSettings";
import type { SavedCall } from "./callJobs";
import { isTrack } from "./callFiles";
import { isValidCallId, makeCallId } from "./callId";
import { CallWriter } from "./chunkStore";
import type { LinkedSession } from "./deepLinkFlow";
import type { BeginResult, EndResult, MicProcessing, RecorderState, SettingsView } from "./ipcTypes";
import { checkRecordingsDir, defaultRecordingsDir } from "./recordingsFolder";
import { recoverLeftovers } from "./recovery";
import { SessionGuard } from "./sessionGuard";
import { SHORTCUTS } from "./shortcuts";

/** 1 s of 32 kbps Opus is ~4 KB; anything near this cap is not a recorder chunk. */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
/** A Solace session armed by a deep link must start recording within this time, or it is dropped. */
const ARMED_SESSION_MS = 60_000;

export interface ControllerDeps {
  userDataDir: string;
  documentsDir: string;
  env: Record<string, string | undefined>;
  appVersion: string;
  onStateChange: (state: RecorderState) => void;
  /** A call is on disk (Stop, or recovered after a crash): hand it to the transcription queue (Step 2). */
  onCallSaved?: (call: SavedCall) => Promise<void> | void;
}

export class RecorderController {
  readonly guard = new SessionGuard();
  private writer: CallWriter | null = null;
  private writerSession: LinkedSession | null = null;
  private armed: { session: LinkedSession; at: number } | null = null;
  private settings: AppSettings = { ...DEFAULT_SETTINGS };
  private notices: string[] = [];

  constructor(private readonly deps: ControllerDeps) {}

  private get settingsFile(): string {
    return join(this.deps.userDataDir, "settings.json");
  }

  async init(): Promise<void> {
    this.settings = await loadSettings(this.settingsFile);
    await this.recover();
  }

  /** The current settings (no secrets live there). */
  get appSettings(): AppSettings {
    return { ...this.settings };
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await saveSettings(this.settingsFile, this.settings);
  }

  /**
   * Step 5: the next Start records this Solace session (call id = session id, D-84) instead of a local-only
   * call. Dropped if no Start comes within a minute (e.g. the mic was blocked).
   */
  armLinkedCall(session: LinkedSession, at: number = Date.now()): void {
    this.armed = { session, at };
  }

  private takeArmed(): LinkedSession | null {
    const a = this.armed;
    this.armed = null;
    return a && Date.now() - a.at <= ARMED_SESSION_MS ? a.session : null;
  }

  /** True when a call folder (finished or in progress) already uses this id; unsafe ids count as taken. */
  hasCall(id: string): boolean {
    if (!isValidCallId(id)) return true;
    if (this.writer?.callId === id) return true;
    const root = this.recordingsDir();
    return existsSync(join(root, id)) || existsSync(join(root, ".in-progress", id));
  }

  recordingsDir(): string {
    return this.settings.recordingsDir ?? defaultRecordingsDir(this.deps.documentsDir, this.deps.env);
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
    for (const x of r.recovered) {
      await this.handOff({ id: x.callId, folder: x.folder, startedAtMs: x.startedAtMs, endedAtMs: x.endedAtMs, session: x.session });
    }
  }

  /** Gives a saved call to the queue. The call is safe on disk whatever happens here. */
  private async handOff(call: SavedCall): Promise<void> {
    try {
      await this.deps.onCallSaved?.(call);
    } catch {
      this.notices.push(`Call ${call.id} is saved, but could not be queued for transcription. Restart the app to try again.`);
    }
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
    const session = this.takeArmed();
    // A Solace call is named by its session id (D-84); a call without a session gets a local id (D-82).
    const callId = session ? session.sessionId : makeCallId(new Date());
    if (session && this.hasCall(callId)) {
      this.guard.ended();
      this.changed();
      return { ok: false, message: 'This Solace call has already been recorded. Press "Call & record" in Solace again for a new call.' };
    }
    try {
      this.writer = await CallWriter.begin({ root: this.recordingsDir(), callId, startedAt: new Date(), micProcessing: mic, appVersion: this.deps.appVersion, session });
      this.writerSession = session;
      // Still "starting": opening the mic and system audio takes 1-2 s. The page reports when audio flows.
      this.changed();
      return { ok: true, callId, linked: session !== null, dialMode: session?.dialMode ?? null };
    } catch {
      this.writer = null;
      this.writerSession = null;
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
    const session = this.writerSession;
    let saved: SavedCall | null = null;
    try {
      const endedAt = new Date();
      const { folder } = await w.finalise({ endedAt, recordedMs: typeof recordedMs === "number" ? recordedMs : 0 });
      saved = { id: w.callId, folder, startedAtMs: w.startedAtMs, endedAtMs: endedAt.getTime(), session };
      return { ok: true, callId: w.callId };
    } catch {
      return { ok: false, message: 'The recording could not be moved to its final name. It stays in the ".in-progress" folder and will be recovered at the next start.' };
    } finally {
      this.writer = null;
      this.writerSession = null;
      this.guard.ended();
      this.changed();
      if (saved) await this.handOff(saved);
    }
  }

  async abortCall(callId: unknown): Promise<void> {
    const w = this.writerFor(callId);
    if (!w) return;
    this.writer = null;
    this.writerSession = null;
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
    this.writerSession = null;
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
