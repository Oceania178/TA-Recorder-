// D-140 for recordings that never finished (APP review I2b): a crash leftover whose recovery failed stays in
// <root>\.in-progress\<id>\. It is deleted, permanently, 3 days after its newest file was written — only
// when the folder holds the app's marker for that same id, never through a link, and never the call being
// recorded right now (`skipId`).
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { readCallMarker, RETENTION_MS, sweepRecordings } from "../core";

const IN_PROGRESS = ".in-progress";
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

async function newestFileMs(folder: string): Promise<number> {
  let newest = 0;
  for (const e of await readdir(folder, { withFileTypes: true })) {
    if (e.isFile()) newest = Math.max(newest, (await stat(join(folder, e.name))).mtimeMs);
  }
  return newest || (await stat(folder)).mtimeMs;
}

export interface InProgressSweep {
  deleted: number;
  kept: number;
  errors: number;
  deletedIds: string[];
}

export async function sweepInProgress(o: { root: string; nowMs: number; skipId?: string | null; retentionMs?: number }): Promise<InProgressSweep> {
  const r: InProgressSweep = { deleted: 0, kept: 0, errors: 0, deletedIds: [] };
  const base = join(o.root, IN_PROGRESS);
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return r;
  }
  const retention = o.retentionMs ?? RETENTION_MS;
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink() || !SAFE_ID.test(e.name) || e.name === o.skipId) continue;
    const folder = join(base, e.name);
    try {
      if ((await lstat(folder)).isSymbolicLink()) continue;
      const marker = await readCallMarker(folder);
      if (!marker || marker.id !== e.name) continue;
      if (o.nowMs - (await newestFileMs(folder)) <= retention) {
        r.kept++;
        continue;
      }
      await rm(folder, { recursive: true, force: true, maxRetries: 3 });
      r.deleted++;
      r.deletedIds.push(e.name);
    } catch {
      r.errors++;
    }
  }
  return r;
}

/** Totals of one retention pass over several recordings folders. */
export interface RootsSweep {
  deleted: number;
  kept: number;
  busy: number;
  notOurs: number;
  errors: number;
  deletedIds: string[];
}

/**
 * D-140 over every recordings folder the app has used (APP review I2a): finished calls by their end time
 * (core's sweepRecordings) and stuck .in-progress leftovers by their newest file (I2b). A folder that is not
 * there is simply skipped. `retentionMs` < 0 deletes everything of ours (the uninstall purge).
 */
export async function sweepRoots(o: {
  roots: readonly string[];
  nowMs: number;
  isBusy(id: string): boolean;
  skipId?: string | null;
  retentionMs?: number;
}): Promise<RootsSweep> {
  const total: RootsSweep = { deleted: 0, kept: 0, busy: 0, notOurs: 0, errors: 0, deletedIds: [] };
  for (const root of o.roots) {
    try {
      const done = await sweepRecordings({ root, nowMs: o.nowMs, isBusy: o.isBusy, retentionMs: o.retentionMs });
      const stuck = await sweepInProgress({ root, nowMs: o.nowMs, skipId: o.skipId, retentionMs: o.retentionMs });
      total.deleted += done.deleted + stuck.deleted;
      total.kept += done.kept + stuck.kept;
      total.busy += done.busy;
      total.notOurs += done.notOurs;
      total.errors += done.errors + stuck.errors;
      total.deletedIds.push(...done.deletedIds, ...stuck.deletedIds);
    } catch {
      total.errors++;
    }
  }
  return total;
}
