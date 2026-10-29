// Settings: the pinned Solace address (https only, D-143), the Gemini key (saved encrypted, shown back only as
// its last 4 characters, D-141), the Gemini model. The folder and mic switch stay in recorder.ts.
import type { SettingsChange, SettingsView } from "../main/ipcTypes";
import { api } from "./bridge";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function result(id: string, text: string | null, kind: "ok" | "error" | "info" = "ok"): void {
  const e = $(id);
  e.textContent = text ?? "";
  e.className = `message ${kind}`;
  e.hidden = !text;
}

export function renderSettingsPanel(view: SettingsView): void {
  $("dev-badge").hidden = !view.dev;
  $("solace-current").textContent = view.solaceBaseUrl ? `Pinned: ${view.solaceBaseUrl}` : "Not set: calls from Solace cannot start until it is.";
  const url = $("solace-url") as HTMLInputElement;
  if (document.activeElement !== url) url.value = view.solaceBaseUrl ?? "";
  $("key-current").textContent = view.geminiKeyHint
    ? `Saved: ${view.geminiKeyHint}`
    : view.keyStorageOk
      ? "No key: calls are recorded but not transcribed."
      : "Windows secure storage is not available for this user: a key cannot be saved.";
  ($("btn-key-clear") as HTMLButtonElement).disabled = !view.geminiKeyHint;
  ($("btn-key-save") as HTMLButtonElement).disabled = !view.keyStorageOk;
  const model = $("gemini-model") as HTMLInputElement;
  model.placeholder = view.geminiModel;
  if (document.activeElement !== model) model.value = view.geminiModelIsDefault ? "" : view.geminiModel;
}

export function initSettingsPanel(onChange: (view: SettingsView) => void): void {
  const apply = (resultId: string, okText: string) => (c: SettingsChange) => {
    onChange(c.view);
    result(resultId, c.problem ?? okText, c.problem ? "error" : "ok");
  };
  $("btn-solace-save").addEventListener("click", async () => {
    apply("solace-result", "Saved.")(await api().setSolaceAddress(($("solace-url") as HTMLInputElement).value));
  });
  $("btn-solace-test").addEventListener("click", async () => {
    result("solace-result", "Testing…", "info");
    const r = await api().testSolaceAddress(($("solace-url") as HTMLInputElement).value);
    result("solace-result", r.message, r.ok ? "ok" : "error");
  });
  $("btn-key-save").addEventListener("click", async () => {
    const input = $("gemini-key") as HTMLInputElement;
    const c = await api().setGeminiKey(input.value);
    if (!c.problem) input.value = "";
    apply("key-result", "Saved. Calls waiting for a key are being transcribed now.")(c);
  });
  $("btn-key-clear").addEventListener("click", async () => {
    onChange(await api().clearGeminiKey());
    result("key-result", "Key removed.", "info");
  });
  $("btn-model-save").addEventListener("click", async () => {
    apply("model-result", "Saved. Used for the next transcription.")(await api().setGeminiModel(($("gemini-model") as HTMLInputElement).value));
  });
}
