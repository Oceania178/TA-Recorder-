// Writes one call to disk while it is being recorded (R6: a crash keeps what was recorded).
// Chunks are appended to <root>/.in-progress/<id>/<id>[.left|.right].webm.part in arrival order;
// on Stop the folder moves to <root>/<id>/ and the files get their final names.
import { access, appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { callFileNames, IN_PROGRESS_DIR, partFileName, TRACKS, type Track } from "./callFiles";
import { isValidCallId } from "./callId";
import { writeMetaAtomic, type CallMeta } from "./callMeta";
import { writeCallMarker } from "./coreAdapter";
import type { LinkedSession } from "./deepLinkFlow";
import type { MicProcessing } from "./ipcTypes";

export interface BeginOptions {
  root: string;
  callId: string;
  startedAt: Date;
  micProcessing: MicProcessing;
  appVersion: string;
  /** The Solace session (Step 5); null for a local-only call. */
  session?: LinkedSession | null;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class CallWriter {
  private queue: Promise<unknown> = Promise.resolve();
  private finished = false;

  private constructor(
    readonly root: string,
    readonly callId: string,
    readonly tempDir: string,
    private meta: CallMeta,
  ) {}

  static async begin(o: BeginOptions): Promise<CallWriter> {
    if (!isValidCallId(o.callId)) throw new Error("Refused: unsafe call id");
    const tempDir = join(o.root, IN_PROGRESS_DIR, o.callId);
    await mkdir(tempDir, { recursive: true });
    for (const t of TRACKS) await writeFile(join(tempDir, partFileName(o.callId, t)), new Uint8Array(0), { flag: "a" });
    const names = callFileNames(o.callId);
    const meta: CallMeta = {
      schema: 1,
      call_id: o.callId,
      status: "recording",
      recovered: false,
      started_at: o.startedAt.toISOString(),
      ended_at: null,
      recorded_ms: null,
      pause_handling: "cut",
      pauses: [],
      mic_processing: o.micProcessing,
      files: { stereo: names.stereo, left: names.left, right: names.right },
      app_version: o.appVersion,
      session: o.session ? { session_id: o.session.sessionId, dial_mode: o.session.dialMode, send_by: o.session.sendBy } : null,
    };
    await writeMetaAtomic(join(tempDir, names.meta), meta);
    await writeCallMarker(tempDir, { id: o.callId, startedAt: meta.started_at as string, endedAt: null });
    return new CallWriter(o.root, o.callId, tempDir, meta);
  }

  /** Runs jobs one after another, in the order they were asked for. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  get startedAtMs(): number {
    return Date.parse(this.meta.started_at as string);
  }

  get isFinished(): boolean {
    return this.finished;
  }

  append(track: Track, data: Uint8Array): Promise<void> {
    if (this.finished) return Promise.reject(new Error("This call has finished; chunk refused"));
    return this.enqueue(() => appendFile(join(this.tempDir, partFileName(this.callId, track)), data));
  }

  /** Resolves once every write asked for so far is on disk. */
  flush(): Promise<void> {
    return this.enqueue(async () => undefined);
  }

  markPause(e: { kind: "pause" | "resume"; at: Date; recordedMs: number }): Promise<void> {
    if (this.finished) return Promise.reject(new Error("This call has finished"));
    if (e.kind === "pause") {
      this.meta.pauses.push({ at_recorded_ms: Math.round(e.recordedMs), paused_at: e.at.toISOString(), resumed_at: null });
    } else {
      const open = this.meta.pauses[this.meta.pauses.length - 1];
      if (open && open.resumed_at === null) open.resumed_at = e.at.toISOString();
    }
    return this.enqueue(() => this.writeMeta());
  }

  private writeMeta(): Promise<void> {
    return writeMetaAtomic(join(this.tempDir, callFileNames(this.callId).meta), this.meta);
  }

  /** Stop: wait for the last chunks, rename the files and move the folder. Never overwrites (D-84). */
  finalise(o: { endedAt: Date; recordedMs: number }): Promise<{ folder: string }> {
    if (this.finished) return Promise.reject(new Error("This call has finished"));
    return this.enqueue(async () => {
      const finalDir = join(this.root, this.callId);
      if (await pathExists(finalDir)) throw new Error("A call folder with this id already exists; nothing was overwritten");
      this.meta.status = "complete";
      this.meta.ended_at = o.endedAt.toISOString();
      this.meta.recorded_ms = Math.round(o.recordedMs);
      const open = this.meta.pauses[this.meta.pauses.length - 1];
      if (open && open.resumed_at === null) open.resumed_at = this.meta.ended_at;
      await this.writeMeta();
      await writeCallMarker(this.tempDir, { id: this.callId, startedAt: this.meta.started_at as string, endedAt: this.meta.ended_at });
      await renamePartsToFinal(this.tempDir, this.callId);
      await rename(this.tempDir, finalDir);
      this.finished = true;
      return { folder: finalDir };
    });
  }

  /** Used when a start fails before any audio: removes the in-progress folder. */
  abort(): Promise<void> {
    this.finished = true;
    return this.enqueue(() => rm(this.tempDir, { recursive: true, force: true }));
  }
}

/** Renames <id>*.webm.part to <id>*.webm inside a folder (missing parts are skipped). */
export async function renamePartsToFinal(dir: string, callId: string): Promise<void> {
  const names = callFileNames(callId);
  for (const t of TRACKS) {
    const part = join(dir, partFileName(callId, t));
    if (await pathExists(part)) await rename(part, join(dir, names[t]));
  }
}
