// R6: on startup, turn chunks left behind by a crash into a finished recording marked "recovered".
import { readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { callFileNames, IN_PROGRESS_DIR, partFileName, TRACKS } from "./callFiles";
import { isValidCallId } from "./callId";
import { writeMetaAtomic, type CallMeta } from "./callMeta";
import { pathExists, renamePartsToFinal } from "./chunkStore";

export interface RecoveryResult {
  recovered: { callId: string; folder: string }[];
  /** Leftovers with no audio at all (crash right after Start): removed. */
  discardedEmpty: number;
  /** Call ids that could not be moved (e.g. a finished folder with the same id exists); left in place. */
  failed: string[];
}

async function readMeta(file: string): Promise<Partial<CallMeta> | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function recoverLeftovers(root: string, opts: { skipCallId?: string } = {}): Promise<RecoveryResult> {
  const result: RecoveryResult = { recovered: [], discardedEmpty: 0, failed: [] };
  const base = join(root, IN_PROGRESS_DIR);
  if (!(await pathExists(base))) return result;

  for (const entry of await readdir(base, { withFileTypes: true })) {
    const callId = entry.name;
    if (!entry.isDirectory() || !isValidCallId(callId) || callId === opts.skipCallId) continue;
    const dir = join(base, callId);
    try {
      let totalBytes = 0;
      let lastWrite = 0;
      for (const t of TRACKS) {
        const part = join(dir, partFileName(callId, t));
        if (!(await pathExists(part))) continue;
        const s = await stat(part);
        totalBytes += s.size;
        lastWrite = Math.max(lastWrite, s.mtimeMs);
      }
      if (totalBytes === 0) {
        await rm(dir, { recursive: true, force: true });
        result.discardedEmpty += 1;
        continue;
      }
      const finalDir = join(root, callId);
      if (await pathExists(finalDir)) {
        result.failed.push(callId);
        continue;
      }
      const names = callFileNames(callId);
      const old = (await readMeta(join(dir, names.meta))) ?? {};
      const meta: CallMeta = {
        schema: 1,
        call_id: callId,
        status: "recovered",
        recovered: true,
        started_at: typeof old.started_at === "string" ? old.started_at : null,
        ended_at: new Date(lastWrite).toISOString(),
        recorded_ms: null,
        pause_handling: "cut",
        pauses: Array.isArray(old.pauses) ? old.pauses : [],
        mic_processing: old.mic_processing ?? null,
        files: { stereo: names.stereo, left: names.left, right: names.right },
        app_version: typeof old.app_version === "string" ? old.app_version : null,
      };
      await writeMetaAtomic(join(dir, names.meta), meta);
      await renamePartsToFinal(dir, callId);
      await rename(dir, finalDir);
      result.recovered.push({ callId, folder: finalDir });
    } catch {
      result.failed.push(callId);
    }
  }
  return result;
}
