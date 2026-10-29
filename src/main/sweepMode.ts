// `TA Call Recorder.exe --sweep`: what the Windows logon task runs (D-140) — delete call folders older than
// 3 days, headless, then exit. No window, no tray, no network.
// - Reads settings.json for the recordings folder (the same default as the app).
// - Reads queue.json read-only to know which calls are being transcribed or sent (never deleted then). It
//   never writes the queue: the app forgets jobs whose folder is gone at its next start.
// - Deletes the upload-ticket file of every deleted call (the encrypted content is never read).
// - Logs counts only.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sweepRecordings } from "../core";
import { loadSettings } from "./appSettings";
import { checkRecordingsDir, defaultRecordingsDir } from "./recordingsFolder";
import { deleteTicketFile } from "./secretStore";

export const SWEEP_FLAG = "--sweep";

export function isSweepMode(argv: readonly string[]): boolean {
  return argv.includes(SWEEP_FLAG);
}

/** Ids whose job is being transcribed or sent, from the queue file, without opening (and so changing) it. */
async function busyIds(queueFile: string): Promise<Set<string>> {
  try {
    const data = JSON.parse(await readFile(queueFile, "utf8")) as { jobs?: { id?: unknown; stage?: unknown }[] };
    const busy = new Set<string>();
    for (const j of data.jobs ?? []) {
      if (typeof j.id === "string" && (j.stage === "transcribing" || j.stage === "sending")) busy.add(j.id);
    }
    return busy;
  } catch {
    return new Set();
  }
}

export interface HeadlessSweepResult {
  /** False when the recordings folder is refused (e.g. inside OneDrive): nothing was touched. */
  ran: boolean;
  deleted: number;
  kept: number;
  busy: number;
  errors: number;
}

export async function runHeadlessSweep(o: {
  userDataDir: string;
  documentsDir: string;
  env: Record<string, string | undefined>;
  nowMs: number;
  log?(event: string, fields: Record<string, unknown>): void;
}): Promise<HeadlessSweepResult> {
  const settings = await loadSettings(join(o.userDataDir, "settings.json"));
  const root = settings.recordingsDir ?? defaultRecordingsDir(o.documentsDir, o.env);
  if (!checkRecordingsDir(root, o.env).ok) {
    o.log?.("retention.sweep_skipped", { reason: "folder_refused" });
    return { ran: false, deleted: 0, kept: 0, busy: 0, errors: 0 };
  }
  const busy = await busyIds(join(o.userDataDir, "queue.json"));
  const r = await sweepRecordings({ root, nowMs: o.nowMs, isBusy: (id) => busy.has(id) });
  for (const id of r.deletedIds) await deleteTicketFile(join(o.userDataDir, "secrets"), id).catch(() => undefined);
  o.log?.("retention.sweep", { mode: "headless", deleted: r.deleted, kept: r.kept, busy: r.busy, not_ours: r.notOurs, errors: r.errors });
  return { ran: true, deleted: r.deleted, kept: r.kept, busy: r.busy, errors: r.errors };
}
