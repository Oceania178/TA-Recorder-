// "Recent calls": date and time, length, linked to Solace or local only, the stage (and why it failed), with
// Retry, Open folder and Open transcript. No candidate names: the app does not know them (D-30).
import type { CallRowView } from "../main/ipcTypes";
import { api } from "./bridge";
import { formatElapsed } from "./elapsedClock";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "", label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function rowElement(r: CallRowView): HTMLLIElement {
  const li = el("li", "call");
  const head = el("div", "call-head");
  head.append(el("span", "call-when", when(r.startedAt)), el("span", `call-stage ${r.stage.toLowerCase()}`, r.stage));
  li.append(head);
  li.append(el("p", "call-meta", `${formatElapsed(r.durationS * 1000)} · ${r.linked ? "Linked to Solace" : "Local only"} · ${r.id}`));
  if (r.detail) li.append(el("p", `call-detail${r.stage === "Failed" ? " failed" : ""}`, r.detail));
  const buttons = el("div", "buttons");
  if (r.canRetry) buttons.append(button("Retry", () => void api().retryCall(r.id).then(refreshCalls)));
  buttons.append(button("Open folder", () => void api().openCallFolder(r.id)));
  if (r.hasTranscript) buttons.append(button("Open transcript", () => void api().openTranscript(r.id)));
  li.append(buttons);
  return li;
}

export async function refreshCalls(): Promise<void> {
  const rows = await api().listCalls();
  $("calls-list").replaceChildren(...rows.map(rowElement));
  $("calls-empty").hidden = rows.length > 0;
  $("calls-key-warning").hidden = !rows.some((r) => r.detail === "Add a Gemini key in Settings to transcribe");
}

export function initRecentCalls(): void {
  api().onCallsChanged(() => void refreshCalls());
  setInterval(() => void refreshCalls(), 30_000);
  void refreshCalls();
}
