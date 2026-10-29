// The app's own small settings file (in the Electron user-data folder). No secrets here, ever.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface AppSettings {
  /** null = the default folder under Documents. */
  recordingsDir: string | null;
  /** P6: browser mic processing (echo cancellation, noise suppression, auto gain). Off by default. */
  micProcessing: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = { recordingsDir: null, micProcessing: false };

export async function loadSettings(file: string): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    const dirOk = raw.recordingsDir === null || typeof raw.recordingsDir === "string";
    const micOk = typeof raw.micProcessing === "boolean";
    if (!dirOk || !micOk) return { ...DEFAULT_SETTINGS };
    return { recordingsDir: raw.recordingsDir, micProcessing: raw.micProcessing };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(file: string, settings: AppSettings): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2), "utf8");
  await rename(tmp, file);
}
