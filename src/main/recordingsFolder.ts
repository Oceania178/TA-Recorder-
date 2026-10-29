// Where recordings live (D-140): default Documents\Sound Recordings\TA Call Recorder\, never under OneDrive (T20).
import { win32 } from "node:path";
import { isUnderOneDrive } from "./coreAdapter";

export function defaultRecordingsDir(documentsDir: string): string {
  return win32.join(documentsDir, "Sound Recordings", "TA Call Recorder");
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
