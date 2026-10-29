// Headless modes of the app (no window, no tray, no network), each runs and exits:
//
// `TA Call Recorder.exe --sweep` — what the Windows logon/daily task runs (D-140): delete call folders older
//   than 3 days in EVERY recordings folder the app has used (APP review I2a), and stuck .in-progress leftovers
//   (I2b). main.ts runs it only while holding the single-instance lock, so the app is not running and no job
//   can really be "busy": a stale transcribing/sending stage in queue.json (a crash) is ignored (I2d). When
//   the app IS running, it gets the --sweep as a second instance and sweeps itself. The queue file is never
//   written: the app forgets jobs whose folder is gone at its next start.
//
// `TA Call Recorder.exe --uninstall-purge` — what the uninstaller runs on a real uninstall (not an update,
//   APP review I2c, fix round 2): delete every call folder of ours, whatever its age, in every known
//   recordings folder (only folders with the app's marker for their own id), then the app's own data in
//   userData: settings, queue, log, and the secret store (Gemini key and upload tickets). It logs nothing:
//   a log line would only recreate the file it just deleted.
//
// Both delete each removed call's upload-ticket file (the encrypted content is never read) and log counts only.
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadSettings, type AppSettings } from "./appSettings";
import { sweepRoots } from "./inProgressSweep";
import { defaultRecordingsDir } from "./recordingsFolder";
import { deleteTicketFile } from "./secretStore";

export const SWEEP_FLAG = "--sweep";
export const PURGE_FLAG = "--uninstall-purge";

export function isSweepMode(argv: readonly string[]): boolean {
  return argv.includes(SWEEP_FLAG);
}

export function isPurgeMode(argv: readonly string[]): boolean {
  return argv.includes(PURGE_FLAG);
}

interface HeadlessContext {
  userDataDir: string;
  documentsDir: string;
  env: Record<string, string | undefined>;
  log?(event: string, fields: Record<string, unknown>): void;
}

/** Every recordings folder in settings (known ones and the current one), each once, drive paths only. */
export function recordingsRoots(settings: AppSettings, documentsDir: string, env: Record<string, string | undefined>): string[] {
  const all = [...settings.knownRecordingsDirs, settings.recordingsDir ?? defaultRecordingsDir(documentsDir, env)];
  const seen = new Set<string>();
  return all.filter((d) => {
    const k = d.toLowerCase();
    if (!/^[a-z]:[\\/]/i.test(d) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface HeadlessSweepResult {
  ran: boolean;
  deleted: number;
  kept: number;
  busy: number;
  errors: number;
}

export async function runHeadlessSweep(o: HeadlessContext & { nowMs: number }): Promise<HeadlessSweepResult> {
  const settings = await loadSettings(join(o.userDataDir, "settings.json"));
  const roots = recordingsRoots(settings, o.documentsDir, o.env);
  // We hold the single-instance lock: nothing is being transcribed or sent, whatever queue.json says.
  const r = await sweepRoots({ roots, nowMs: o.nowMs, isBusy: () => false });
  for (const id of r.deletedIds) await deleteTicketFile(join(o.userDataDir, "secrets"), id).catch(() => undefined);
  o.log?.("retention.sweep", { mode: "headless", folders: roots.length, deleted: r.deleted, kept: r.kept, not_ours: r.notOurs, errors: r.errors });
  return { ran: true, deleted: r.deleted, kept: r.kept, busy: r.busy, errors: r.errors };
}

/** The app's own files in userData (Chromium's folders there are left to the uninstaller's app-data delete). */
const APP_DATA = [/^settings\.json(\.tmp)?$/, /^queue\.json(\..*)?$/, /^app\.log(\.1)?$/, /^secrets$/, /^ta-call-recorder-cleanup-.*\.xml$/];

export async function runUninstallPurge(o: HeadlessContext): Promise<{ deleted: number; errors: number }> {
  const settings = await loadSettings(join(o.userDataDir, "settings.json"));
  const roots = recordingsRoots(settings, o.documentsDir, o.env);
  // 1. The recordings, everywhere they were kept. 2. The app's data: settings, queue, log, key and tickets.
  const r = await sweepRoots({ roots, nowMs: Date.now(), isBusy: () => false, retentionMs: -Number.MAX_SAFE_INTEGER });
  let errors = r.errors;
  let names: string[] = [];
  try {
    names = await readdir(o.userDataDir);
  } catch {
    // no app data
  }
  for (const name of names.filter((n) => APP_DATA.some((p) => p.test(n)))) {
    await rm(join(o.userDataDir, name), { recursive: true, force: true, maxRetries: 3 }).catch(() => void errors++);
  }
  return { deleted: r.deleted, errors };
}
