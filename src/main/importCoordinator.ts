// D-171 "Import a recording": the main process's side of one import attempt (review R3 I1). Pure logic; main.ts
// passes in the file picker, the file check, the live recording and runImport.
//
//   choose()   the gates (notice, Solace call or Test mode, one at a time), the file picker, then the file is
//              READ, not decoded: type, size, length (over 2 hours refused here, before anything else), channels.
//              The page gets an opaque token, never a path. A pick made during a live Solace call is marked so.
//   discard()  the live Solace recording is stopped and deleted; its session is kept for THIS attempt only.
//   run()      the import, with that session (or Local only in Test mode). Whatever happens, the attempt ends:
//              the session and the token are dropped. A failure after the live recording was discarded says so.
//   cancel()   the dialog closed without importing: the attempt ends (a discarded session is never reused).
//   newCallStarted()  a new Solace link or a local start: the attempt ends.
// So a Solace session can never reach a later, unrelated import (a role-play file in Test mode).
import type { LinkedSession } from "./deepLinkFlow";
import { importGate, IMPORT_MESSAGES, MAX_IMPORT_MS } from "./importFlow";
import type { ImportLayout, ImportPick, ImportRunResult } from "./ipcTypes";

export type { ImportLayout };

export const DISCARDED_FAILED = "The recording for this Solace call was discarded and the import failed. Press Call & record in Solace again.";
const NOT_REPLACED = 'The live recording was not replaced. Choose "Import a recording instead…" again.';
const CHOOSE_AGAIN = "Choose the file again.";

export interface InspectedFile {
  ok: true;
  name: string;
  sizeMb: number;
  durationMs: number;
  channels: number;
  /** The name of one of this app's own stereo recordings (the layout question's default). */
  looksLikeAppFile: boolean;
}

export interface CoordinatorDeps {
  state(): { noticeAccepted: boolean; testMode: boolean; liveLinkedCallId: string | null; recording: boolean };
  /** The Windows file picker (or the dev-only e2e file); null when cancelled. */
  pickFile(): Promise<string | null>;
  /** Read the file's header and packets, without decoding (audioDemux.ts). */
  inspect(file: string): Promise<InspectedFile | { ok: false; message: string }>;
  /** Stop and delete the live Solace recording and give its session. */
  takeLiveSession(callId: string): Promise<{ ok: true; session: LinkedSession } | { ok: false; message: string }>;
  run(o: { source: string; session: LinkedSession | null; layout: ImportLayout }): Promise<
    { ok: true; id: string; audio: "stereo" | "mono"; fromFileTime: boolean; durationMs: number; sameOnBoth?: boolean } | { ok: false; message: string }
  >;
  log?(event: string, fields: Record<string, unknown>): void;
  newToken?(): string;
}

interface Pick {
  file: string;
  /** Picked during a live Solace call: only that call's session may take it. */
  forLive: boolean;
}

export class ImportCoordinator {
  private pick: { token: string; p: Pick } | null = null;
  private session: LinkedSession | null = null;
  private importing = false;
  private n = 0;

  constructor(private readonly d: CoordinatorDeps) {}

  /** An import is being copied / decoded (no recording, link or other import meanwhile). */
  get busy(): boolean {
    return this.importing;
  }

  hasSession(): boolean {
    return this.session !== null;
  }

  private endAttempt(): void {
    this.pick = null;
    this.session = null;
  }

  async choose(): Promise<ImportPick> {
    const s = this.d.state();
    const live = s.liveLinkedCallId !== null;
    const gate = importGate({ noticeAccepted: s.noticeAccepted, testMode: s.testMode, linked: live, busy: this.importing || (s.recording && !live) });
    if (gate) return { ok: false, message: gate };
    this.endAttempt();
    const file = await this.d.pickFile();
    if (!file) return { ok: false, cancelled: true };
    const f = await this.d.inspect(file);
    if (!f.ok) return { ok: false, message: f.message };
    if (f.durationMs > MAX_IMPORT_MS) return { ok: false, message: IMPORT_MESSAGES.tooLong };
    const token = this.d.newToken?.() ?? `t${Date.now().toString(36)}${(this.n++).toString(36)}${Math.random().toString(36).slice(2)}`;
    this.pick = { token, p: { file, forLive: live } };
    return { ok: true, token, name: f.name, sizeMb: f.sizeMb, durationMs: f.durationMs, channels: f.channels, looksLikeAppFile: f.looksLikeAppFile, forLive: live };
  }

  async discard(callId: string): Promise<{ ok: boolean; message?: string }> {
    if (!this.pick?.p.forLive) return { ok: false, message: NOT_REPLACED };
    const r = await this.d.takeLiveSession(callId);
    if (!r.ok) {
      this.endAttempt();
      return { ok: false, message: r.message };
    }
    this.session = r.session;
    this.d.log?.("import.live_discarded", {});
    return { ok: true };
  }

  async run(token: string, layout: ImportLayout): Promise<ImportRunResult> {
    const pick = this.pick && this.pick.token === token ? this.pick.p : null;
    if (!pick) {
      this.endAttempt();
      return { ok: false, message: CHOOSE_AGAIN };
    }
    const session = this.session;
    if (pick.forLive && !session) {
      this.endAttempt();
      return { ok: false, message: NOT_REPLACED };
    }
    const s = this.d.state();
    const gate = importGate({ noticeAccepted: s.noticeAccepted, testMode: s.testMode, linked: session !== null, busy: this.importing || s.recording });
    if (gate) {
      this.endAttempt();
      return { ok: false, message: session ? `${gate} ${DISCARDED_FAILED}` : gate };
    }
    this.importing = true;
    // The attempt ends now, whatever happens: this session can never reach another import.
    this.endAttempt();
    try {
      const r = await this.d.run({ source: pick.file, session, layout });
      this.d.log?.("import.done", { ok: r.ok, linked: session !== null, audio: r.ok ? r.audio : null });
      if (r.ok) return { ...r, linked: session !== null };
      return { ok: false, message: session ? `${r.message} ${DISCARDED_FAILED}` : r.message };
    } catch {
      return { ok: false, message: session ? `${IMPORT_MESSAGES.unreadable} ${DISCARDED_FAILED}` : IMPORT_MESSAGES.unreadable };
    } finally {
      this.importing = false;
    }
  }

  /** The import dialog closed without importing. */
  cancel(): void {
    if (this.importing) return;
    if (this.session) this.d.log?.("import.session_dropped", {});
    this.endAttempt();
  }

  /** A new Solace link or a local start began. */
  newCallStarted(): void {
    this.endAttempt();
  }
}
