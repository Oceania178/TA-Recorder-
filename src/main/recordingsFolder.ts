// Where recordings live (D-140): default Documents\Sound Recordings\TA Call Recorder\, never under OneDrive (T20).
// Company laptops often have Documents moved into OneDrive; then the default is
// %LOCALAPPDATA%\TA Call Recorder\Recordings instead (controller decision, 29/10/2026).
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

export function checkRecordingsDir(path: string, env: Record<string, string | undefined>): DirCheck {
  if (!win32.isAbsolute(path)) return { ok: false, message: "The recordings folder must be a full path, e.g. C:\\Users\\you\\Documents\\..." };
  if (isUnderOneDrive(path, env)) {
    return {
      ok: false,
      message: "This folder is inside OneDrive, which would copy call recordings to the cloud. Choose a folder outside OneDrive.",
    };
  }
  return { ok: true };
}
