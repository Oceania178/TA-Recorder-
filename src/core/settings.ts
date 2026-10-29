// core/settings.ts — validating what the TA (or the first-run wizard, D-132) sets:
// - the pinned Solace address (D-143): https only, an origin with no path, query or fragment; plain
//   http://localhost only for development, behind an explicit `dev` flag;
// - the recordings folder (D-140): absolute, and never inside a OneDrive-synced folder (T20);
// - the Gemini model id (D-141), default `gemini-3.5-transcribe`.
// Pure functions: the caller (Electron main) loads and saves the values.
import path from "node:path";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-transcribe";

export type Env = Record<string, string | undefined>;

export type SolaceUrlRefusal =
  | "empty" | "not_a_url" | "not_https" | "has_path" | "has_query" | "has_fragment" | "has_credentials";

const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The pinned Solace address as a bare origin (`https://host[:port]`), or why it is refused. */
export function validateSolaceBaseUrl(
  raw: unknown, opts: { dev?: boolean } = {},
): { ok: true; url: string } | { ok: false; reason: SolaceUrlRefusal } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, reason: "empty" };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, reason: "not_a_url" };
  }
  const devHttp = opts.dev === true && u.protocol === "http:" && DEV_HOSTS.has(u.hostname);
  if (u.protocol !== "https:" && !devHttp) return { ok: false, reason: "not_https" };
  if (!u.hostname) return { ok: false, reason: "not_a_url" };
  if (u.username || u.password) return { ok: false, reason: "has_credentials" };
  if (u.pathname !== "/" && u.pathname !== "") return { ok: false, reason: "has_path" };
  if (u.search || text.includes("?")) return { ok: false, reason: "has_query" };
  if (u.hash || text.includes("#")) return { ok: false, reason: "has_fragment" };
  return { ok: true, url: u.origin };
}

const ONEDRIVE_VARS = ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"] as const;

/** Windows paths compare case-insensitively, with either slash and no trailing separator. */
function normaliseWin(p: string): string {
  const n = path.win32.normalize(p.trim()).toLowerCase();
  return n.length > 3 && n.endsWith("\\") ? n.slice(0, -1) : n;
}

const isWithin = (child: string, root: string): boolean =>
  child === root || child.startsWith(root.endsWith("\\") ? root : `${root}\\`);

/**
 * True when `p` is inside a OneDrive-synced folder: under any of the OneDrive, OneDriveCommercial or
 * OneDriveConsumer folders from the environment, or in a folder named `OneDrive` or `OneDrive - <org>`.
 */
export function isUnderOneDrive(p: string, env: Env): boolean {
  const target = normaliseWin(p);
  for (const name of ONEDRIVE_VARS) {
    const root = env[name]?.trim();
    if (root && isWithin(target, normaliseWin(root))) return true;
  }
  return target.split("\\").some((part) => part === "onedrive" || part.startsWith("onedrive - "));
}

/** `Documents\Sound Recordings\TA Call Recorder` under the given Documents folder (D-140). */
export function defaultRecordingsFolder(documentsDir: string): string {
  return path.win32.join(documentsDir, "Sound Recordings", "TA Call Recorder");
}

export type FolderRefusal = "empty" | "not_absolute" | "under_onedrive";

export function validateRecordingsFolder(
  raw: unknown, env: Env,
): { ok: true; path: string } | { ok: false; reason: FolderRefusal } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, reason: "empty" };
  if (!path.win32.isAbsolute(text) || !/^([a-z]:|\\\\)/i.test(text)) return { ok: false, reason: "not_absolute" };
  if (isUnderOneDrive(text, env)) return { ok: false, reason: "under_onedrive" };
  let p = path.win32.normalize(text);
  if (p.length > 3 && p.endsWith("\\")) p = p.slice(0, -1);
  return { ok: true, path: p };
}

/** Model ids go into the request URL, so only plain ids pass (no slash, colon, query or space). */
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export function validateGeminiModel(raw: unknown): { ok: true; model: string } | { ok: false; reason: "invalid_model" } {
  const m = typeof raw === "string" ? raw.trim() : "";
  return MODEL_ID.test(m) ? { ok: true, model: m } : { ok: false, reason: "invalid_model" };
}

export interface AppSettings {
  /** Null until the first-run wizard pins it (D-132 step 4); nothing is sent while it is null. */
  solaceBaseUrl: string | null;
  recordingsFolder: string;
  geminiModel: string;
}

export interface SettingsError {
  field: keyof AppSettings;
  reason: string;
}

/** Settings as stored (any shape) → validated settings with defaults, or every bad field. */
export function normaliseSettings(
  input: unknown, ctx: { documentsDir: string; env: Env; dev?: boolean },
): { ok: true; settings: AppSettings } | { ok: false; errors: SettingsError[] } {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const errors: SettingsError[] = [];

  let solaceBaseUrl: string | null = null;
  if (raw.solaceBaseUrl != null && raw.solaceBaseUrl !== "") {
    const r = validateSolaceBaseUrl(raw.solaceBaseUrl, { dev: ctx.dev });
    if (r.ok) solaceBaseUrl = r.url;
    else errors.push({ field: "solaceBaseUrl", reason: r.reason });
  }

  let recordingsFolder = defaultRecordingsFolder(ctx.documentsDir);
  const folder = validateRecordingsFolder(raw.recordingsFolder ?? recordingsFolder, ctx.env);
  if (folder.ok) recordingsFolder = folder.path;
  else errors.push({ field: "recordingsFolder", reason: folder.reason });

  let geminiModel = DEFAULT_GEMINI_MODEL;
  if (raw.geminiModel != null && raw.geminiModel !== "") {
    const m = validateGeminiModel(raw.geminiModel);
    if (m.ok) geminiModel = m.model;
    else errors.push({ field: "geminiModel", reason: m.reason });
  }

  return errors.length ? { ok: false, errors } : { ok: true, settings: { solaceBaseUrl, recordingsFolder, geminiModel } };
}
