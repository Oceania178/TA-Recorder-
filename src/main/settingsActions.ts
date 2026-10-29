// What the Settings panel (and wizard step 4) can change. Each action returns a plain-words problem, or null
// when the change was saved. The Gemini key goes to the secret store only, never to settings.json.
import { validateGeminiModel, validateSolaceBaseUrl } from "../core";
import type { AppSettings } from "./appSettings";
import type { SecretStore } from "./secretStore";

export interface SettingsHost {
  get(): AppSettings;
  save(patch: Partial<AppSettings>): Promise<void>;
  isRecording(): boolean;
  secrets: SecretStore;
  /** Development build started with --dev: http://localhost is allowed as the Solace address. */
  dev: boolean;
  /** The key was added, changed or removed: the queue picks calls waiting for a key back up. */
  keyChanged(): void;
}

const DURING_CALL = "You can change this after this recording stops.";

const SOLACE_PROBLEMS: Record<string, string> = {
  empty: "Enter the Solace address, e.g. https://solace.example.vn",
  not_a_url: "That is not a web address. Example: https://solace.example.vn",
  not_https: "The Solace address must start with https:// (the transcript is only ever sent over https).",
  has_path: "Enter only the address, without anything after the name (no /api, no page).",
  has_query: "Enter only the address, without anything after the name (no ?…).",
  has_fragment: "Enter only the address, without anything after the name (no #…).",
  has_credentials: "The address must not contain a user name or password.",
};

/** Pins the Solace address (D-143): an https origin only; http://localhost only in a --dev build. */
export async function setSolaceAddress(h: SettingsHost, raw: unknown): Promise<string | null> {
  if (h.isRecording()) return DURING_CALL;
  const r = validateSolaceBaseUrl(raw, { dev: h.dev });
  if (!r.ok) return SOLACE_PROBLEMS[r.reason] ?? "That Solace address cannot be used.";
  await h.save({ solaceBaseUrl: r.url });
  return null;
}

/** Empty = back to the default model. */
export async function setGeminiModel(h: SettingsHost, raw: unknown): Promise<string | null> {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    await h.save({ geminiModel: null });
    return null;
  }
  const r = validateGeminiModel(text);
  if (!r.ok) return "That model name is not valid. Use a plain model id such as gemini-3.5-transcribe.";
  await h.save({ geminiModel: r.model });
  return null;
}

export async function setGeminiKey(h: SettingsHost, raw: unknown): Promise<string | null> {
  const r = await h.secrets.setGeminiKey(typeof raw === "string" ? raw : "");
  if (!r.ok) return r.message;
  h.keyChanged();
  return null;
}

export async function clearGeminiKey(h: SettingsHost): Promise<void> {
  await h.secrets.clearGeminiKey();
  h.keyChanged();
}
