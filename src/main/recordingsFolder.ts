// Where recordings live (D-140): default Documents\Sound Recordings\TA Call Recorder\, never under OneDrive (T20).
// Company laptops often have Documents moved into OneDrive; then the default is
// %LOCALAPPDATA%\TA Call Recorder\Recordings instead (controller decision, 29/10/2026).
import { realpathSync } from "node:fs";
import { win32 } from "node:path";
import { isUnderOneDrive } from "./coreAdapter";

export function defaultRecordingsDir(documentsDir: string, env: Record<string, string | undefined> = {}): string {
  const underDocuments = win32.join(documentsDir, "Sound Recordings", "TA Call Recorder");
  const local = env.LOCALAPPDATA?.trim();
  if (isUnderOneDrive(underDocuments, env) && local && win32.isAbsolute(local) && !isUnderOneDrive(local, env)) {
    return win32.join(local, "TA Call Recorder", "Recordings");
  }
  return underDocuments;
}

export type DirCheck = { ok: true } | { ok: false; message: string };

/** Where a drive letter really points: "C:\\" for a local disk, "\\\\server\\share\\" for a mapped network drive. */
function realDriveRoot(root: string): string | null {
  try {
    return realpathSync.native(root);
  } catch {
    return null; // not there: a disconnected network drive, or an unplugged one
  }
}

const NETWORK = "This folder is on a network drive. Pick a folder on this laptop.";
const NOT_CONNECTED = "This drive is not connected (a network or removable drive?). Pick a folder on this laptop.";

export function checkRecordingsDir(
  path: string,
  env: Record<string, string | undefined>,
  o: { driveRoot?: (root: string) => string | null } = {},
): DirCheck {
  if (path.startsWith("\\\\") || path.startsWith("//")) return { ok: false, message: NETWORK };
  if (!/^[a-z]:[\\/]/i.test(path)) return { ok: false, message: "The recordings folder must be a full path, e.g. C:\\Users\\you\\Documents\\..." };
  const root = (o.driveRoot ?? realDriveRoot)(`${path.slice(0, 2).toUpperCase()}\\`);
  if (root === null) return { ok: false, message: NOT_CONNECTED };
  if (root.startsWith("\\\\") || root.startsWith("//")) return { ok: false, message: NETWORK };
  if (isUnderOneDrive(path, env)) {
    return {
      ok: false,
      message: "This folder is inside OneDrive, which would copy call recordings to the cloud. Choose a folder outside OneDrive.",
    };
  }
  return { ok: true };
}
