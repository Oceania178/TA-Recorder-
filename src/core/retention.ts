// core/retention.ts — delete each call's folder 3 days after the call ended (D-140): permanently, with
// fs.rm (never the Recycle Bin), and only folders the app created.
//
// - Each call has its own folder under the recordings folder, named by the call id, with a marker file
//   (MARKER_FILE) the app writes when recording starts and again at Stop with the end time. A folder
//   without a matching marker is not ours and is never touched; links / junctions are never followed.
// - The clock starts at the marker's `ended_at`. A recording that never got one (the app crashed) is
//   judged by its newest file's modification time.
// - Decision (APP-B, documented in docs/plan.md): the folder is deleted at 3 days WHATEVER the job's
//   stage — sent, local only, failed or still waiting — because the spec sets 3 days and the 72 h send
//   window (D-144) has closed by then anyway. The one exception: never while the job is being transcribed
//   or sent (`isBusy`); the next sweep takes it.
// - The result is counts for the log, plus `deletedIds` for the queue (JobQueue.forget) — never log those.
import { lstat, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomicWrite";

export const RETENTION_MS = 72 * 3600_000;
export const MARKER_FILE = "ta-call-recorder.call.json";
const APP = "ta-call-recorder";
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface CallMarker {
  app: typeof APP;
  id: string;
  started_at: string;
  ended_at: string | null;
}

/** Write (or rewrite at Stop, with the end time) the marker in a call's folder. Times are ISO strings. */
export async function writeCallMarker(folder: string, m: { id: string; startedAt: string; endedAt: string | null }): Promise<void> {
  if (!SAFE_ID.test(m.id)) throw new Error("unsafe call id");
  const marker: CallMarker = { app: APP, id: m.id, started_at: m.startedAt, ended_at: m.endedAt };
  await writeFileAtomic(path.join(folder, MARKER_FILE), `${JSON.stringify(marker)}\n`);
}

export async function readCallMarker(folder: string): Promise<CallMarker | null> {
  try {
    const m = JSON.parse(await readFile(path.join(folder, MARKER_FILE), "utf8")) as CallMarker;
    const ok = m && m.app === APP && typeof m.id === "string" && typeof m.started_at === "string"
      && (m.ended_at === null || typeof m.ended_at === "string");
    return ok ? m : null;
  } catch {
    return null;
  }
}

export interface SweepReport {
  /** ISO time of the sweep (D-140: record when deletion happened). */
  at: string;
  deleted: number;
  kept: number;
  /** Old enough, but being transcribed or sent right now. */
  busy: number;
  /** Folders without the app's marker: never touched. */
  notOurs: number;
  errors: number;
  /** For JobQueue.forget only — never log these. */
  deletedIds: string[];
}

async function newestFileTime(folder: string): Promise<number> {
  let newest = 0;
  for (const e of await readdir(folder, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    newest = Math.max(newest, (await stat(path.join(folder, e.name))).mtimeMs);
  }
  if (!newest) newest = (await stat(folder)).mtimeMs;
  return newest;
}

export async function sweepRecordings(o: {
  root: string;
  nowMs: number;
  isBusy: (id: string) => boolean;
  retentionMs?: number;
}): Promise<SweepReport> {
  const report: SweepReport = { at: new Date(o.nowMs).toISOString(), deleted: 0, kept: 0, busy: 0, notOurs: 0, errors: 0, deletedIds: [] };
  const retention = o.retentionMs ?? RETENTION_MS;

  let entries;
  try {
    entries = await readdir(o.root, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return report;
    throw e;
  }

  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const folder = path.join(o.root, e.name);
    try {
      if ((await lstat(folder)).isSymbolicLink()) continue;
      const marker = await readCallMarker(folder);
      if (!marker || marker.id !== e.name || !SAFE_ID.test(e.name)) {
        report.notOurs++;
        continue;
      }
      const endedMs = marker.ended_at ? Date.parse(marker.ended_at) : NaN;
      const since = Number.isNaN(endedMs) ? await newestFileTime(folder) : endedMs;
      if (o.nowMs - since <= retention) {
        report.kept++;
        continue;
      }
      if (o.isBusy(marker.id)) {
        report.busy++;
        continue;
      }
      await rm(folder, { recursive: true, force: true, maxRetries: 3 });
      report.deleted++;
      report.deletedIds.push(marker.id);
    } catch {
      report.errors++;
    }
  }
  return report;
}
