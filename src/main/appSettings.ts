// The app's own small settings file (settings.json in the Electron user-data folder). No secrets here, ever:
// the Gemini key and upload tickets live in secretStore.ts (Windows DPAPI through Electron safeStorage).
// Only the fields below are ever written, so nothing else can end up in this file by mistake.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface AppSettings {
  /** null = the default folder (Documents\Sound Recordings\TA Call Recorder, or %LOCALAPPDATA% if Documents is in OneDrive). */
  recordingsDir: string | null;
  /** P6: browser mic processing (echo cancellation, noise suppression, auto gain). Off by default. */
  micProcessing: boolean;
  /** The pinned Solace address (D-143), an https origin; null until the TA sets it (wizard step 4). */
  solaceBaseUrl: string | null;
  /** null = core's default model (DEFAULT_GEMINI_MODEL). */
  geminiModel: string | null;
  /** When the TA clicked "I understand" on the first-run notice (wizard step 1, D-126, D-132). */
  noticeAcceptedAt: string | null;
  /** When the TA finished the first-run wizard (it can be run again from the tray). */
  wizardDoneAt: string | null;
  /** The program path + version the logon cleanup task was created for (D-140); re-created when it changes. */
  cleanupTaskFor: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  recordingsDir: null,
  micProcessing: false,
  solaceBaseUrl: null,
  geminiModel: null,
  noticeAcceptedAt: null,
  wizardDoneAt: null,
  cleanupTaskFor: null,
};

const FIELDS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];

const stringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

/** Reads the file field by field: a bad field falls back to its default, the good ones are kept. */
export async function loadSettings(file: string): Promise<AppSettings> {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    raw = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  const s: AppSettings = { ...DEFAULT_SETTINGS };
  if (stringOrNull(raw.recordingsDir)) s.recordingsDir = raw.recordingsDir;
  if (typeof raw.micProcessing === "boolean") s.micProcessing = raw.micProcessing;
  if (stringOrNull(raw.solaceBaseUrl)) s.solaceBaseUrl = raw.solaceBaseUrl;
  if (stringOrNull(raw.geminiModel)) s.geminiModel = raw.geminiModel;
  if (stringOrNull(raw.noticeAcceptedAt)) s.noticeAcceptedAt = raw.noticeAcceptedAt;
  if (stringOrNull(raw.wizardDoneAt)) s.wizardDoneAt = raw.wizardDoneAt;
  if (stringOrNull(raw.cleanupTaskFor)) s.cleanupTaskFor = raw.cleanupTaskFor;
  return s;
}

export async function saveSettings(file: string, settings: AppSettings): Promise<void> {
  const known: Record<string, unknown> = {};
  for (const f of FIELDS) known[f] = settings[f] ?? DEFAULT_SETTINGS[f];
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(known, null, 2), "utf8");
  await rename(tmp, file);
}
