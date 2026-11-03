// D-171 "Import a recording" in the recorder window: the import dialog (pick a file, see the progress) and the
// "Which voice is yours?" dialog of a mono import. Main does the work (src/main/importFlow.ts); the page never
// sees a file path, only the name the TA picked.
import type { ImportLayout, ImportPick, SpeakerPreviewView } from "../main/ipcTypes";
import { api } from "./bridge";
import { formatElapsed } from "./elapsedClock";
import { importDone, layoutDefault, layoutHint, speakerSendLabel } from "./importText";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface ImportHost {
  /** The live recording is a Solace call that an import may replace. */
  liveLinked(): boolean;
  /** Stop and delete the live Solace recording so the import takes its session. */
  discardLive(): Promise<boolean>;
  /** Why the last discardLive() failed, if it did. */
  lastError(): string | null;
  afterImport(): void;
}

let host: ImportHost;
let busy = false;
let speakersFor: { id: string; linked: boolean } | null = null;

function status(id: string, kind: "pass" | "notyet" | "", text: string): void {
  const el = $(id);
  el.textContent = text;
  el.className = `wizard-status ${kind}`;
}

const mmss = (ms: number) => formatElapsed(ms).replace(/^00:/, "");

// ---------------------------------------------------------------- import dialog
// Step 1: choose a file (main reads it, not decodes it: type, size, length ≤ 2 h, channels).
// Step 2: for a two-channel file, how it is laid out (review R3 I3). Then Import: only now is a live Solace
// recording replaced, and the import runs. Closing the dialog ends the attempt (review R3 I1).
let pick: Extract<ImportPick, { ok: true }> | null = null;

function resetDialog(): void {
  pick = null;
  $("import-picked").hidden = true;
  ($("import-choose") as HTMLButtonElement).hidden = false;
  ($("import-choose") as HTMLButtonElement).disabled = false;
  ($("import-run") as HTMLButtonElement).hidden = true;
}

export function openImportDialog(): void {
  if (busy) return;
  resetDialog();
  $("import-live-warning").hidden = !host.liveLinked();
  $("import-close").textContent = "Cancel";
  status("import-status", "", "");
  $("import-dialog").hidden = false;
  $("import-title").focus();
}

function closeImportDialog(): void {
  if (busy) return;
  $("import-dialog").hidden = true;
  resetDialog();
  api().cancelImport();
}

async function choose(): Promise<void> {
  if (busy) return;
  const p: ImportPick = await api().chooseImportFile();
  if (!p.ok) {
    if (!p.cancelled) status("import-status", "notyet", p.message ?? "This file can't be imported.");
    return;
  }
  pick = p;
  $("import-file").textContent = `${p.name} · ${mmss(p.durationMs)} · ${p.sizeMb} MB · ${p.channels === 1 ? "one channel" : `${p.channels} channels`}`;
  const twoChannels = p.channels >= 2;
  $("import-layout").hidden = !twoChannels;
  if (twoChannels) {
    const def = layoutDefault(p.looksLikeAppFile);
    document.querySelectorAll<HTMLInputElement>('input[name="import-layout"]').forEach((r) => (r.checked = r.value === def));
    $("import-layout-hint").textContent = layoutHint(p.looksLikeAppFile);
  }
  $("import-picked").hidden = false;
  ($("import-choose") as HTMLButtonElement).hidden = true;
  ($("import-run") as HTMLButtonElement).hidden = false;
  status("import-status", "", p.forLive ? "Press Import: the live recording stops and is deleted, then the file is imported for this Solace call." : "Press Import.");
}

async function runChosen(): Promise<void> {
  if (busy || !pick) return;
  const p = pick;
  const layout = (p.channels >= 2 ? document.querySelector<HTMLInputElement>('input[name="import-layout"]:checked')?.value : "mixed") as ImportLayout | undefined;
  busy = true;
  ($("import-run") as HTMLButtonElement).disabled = true;
  ($("import-close") as HTMLButtonElement).disabled = true;
  try {
    if (p.forLive && !(await host.discardLive())) {
      status("import-status", "notyet", host.lastError() ?? "The live recording could not be replaced. Press Call & record in Solace again.");
      return;
    }
    const r = await api().runImport(p.token, layout ?? "mixed");
    if (r.ok) {
      status("import-status", "pass", importDone(r, r.linked));
      $("import-close").textContent = "Close";
      host.afterImport();
    } else {
      status("import-status", "notyet", r.message);
    }
  } finally {
    busy = false;
    pick = null;
    $("import-picked").hidden = true;
    ($("import-run") as HTMLButtonElement).hidden = true;
    ($("import-run") as HTMLButtonElement).disabled = false;
    ($("import-choose") as HTMLButtonElement).hidden = false;
    ($("import-close") as HTMLButtonElement).disabled = false;
    $("import-live-warning").hidden = !host.liveLinked();
  }
}

// ---------------------------------------------------------------- "Which voice is yours?"
function chunkElement(c: SpeakerPreviewView["chunks"][number], many: boolean): HTMLElement {
  const box = document.createElement("div");
  box.className = "speaker-chunk";
  const h = document.createElement("h3");
  h.textContent = many ? `Part ${c.index + 1} · ${mmss(c.start_ms)}–${mmss(c.end_ms)}` : `First lines · ${mmss(c.start_ms)}–${mmss(c.end_ms)}`;
  const list = document.createElement("ol");
  for (const t of c.turns) {
    const li = document.createElement("li");
    const letter = Object.assign(document.createElement("span"), { className: "letter", textContent: `${t.label} [${mmss(t.start_ms)}]` });
    letter.dataset.label = t.label;
    li.append(letter, document.createTextNode(t.text));
    list.append(li);
  }
  if (!c.turns.length) list.append(Object.assign(document.createElement("li"), { textContent: "(no speech found in this part)" }));
  box.append(h);
  if (c.unclear) box.append(Object.assign(document.createElement("p"), { className: "doubt", textContent: "This part could not be transcribed. It shows as [không nghe rõ] in the transcript." }));
  else if (c.unsure && many) box.append(Object.assign(document.createElement("p"), { className: "doubt", textContent: "Check this part: the letters may be the other way round." }));
  box.append(list);
  if (many) {
    const label = document.createElement("label");
    label.className = "checkbox";
    const box2 = Object.assign(document.createElement("input"), { type: "checkbox", checked: c.flipped });
    box2.dataset.chunk = String(c.index);
    box2.className = "speaker-swap";
    label.append(box2, document.createTextNode(" Swap A and B in this part"));
    box.append(label);
  }
  return box;
}

function markMine(): void {
  const me = (document.querySelector<HTMLInputElement>('input[name="speaker-me"]:checked')?.value ?? "A") as "A" | "B";
  document.querySelectorAll<HTMLElement>(".speaker-chunk").forEach((box) => {
    const swapped = box.querySelector<HTMLInputElement>(".speaker-swap")?.checked === true;
    box.querySelectorAll<HTMLElement>(".letter").forEach((l) => {
      const label = swapped ? (l.dataset.label === "A" ? "B" : "A") : l.dataset.label;
      l.classList.toggle("ta", label === me);
    });
  });
}

/** For `id`, or the first call that waits for a choice. */
export async function openSpeakerDialog(id?: string): Promise<void> {
  const rows = await api().listCalls();
  const row = rows.find((r) => r.needsSpeakers && (!id || r.id === id));
  if (!row) return;
  const preview = await api().speakerPreview(row.id);
  if (!preview) return;
  speakersFor = { id: row.id, linked: row.linked };
  const many = preview.chunks.length > 1;
  $("speakers-chunks").replaceChildren(...preview.chunks.map((c) => chunkElement(c, many)));
  ($("speakers-send") as HTMLButtonElement).textContent = speakerSendLabel(row.linked);
  ($("speakers-send") as HTMLButtonElement).disabled = false;
  status("speakers-status", "", "");
  markMine();
  $("speakers-dialog").hidden = false;
  $("speakers-title").focus();
}

async function sendChoice(): Promise<void> {
  if (!speakersFor) return;
  const me = (document.querySelector<HTMLInputElement>('input[name="speaker-me"]:checked')?.value ?? "A") as "A" | "B";
  const swapped = Array.from(document.querySelectorAll<HTMLInputElement>(".speaker-swap:checked")).map((b) => Number(b.dataset.chunk));
  ($("speakers-send") as HTMLButtonElement).disabled = true;
  const ok = await api().chooseSpeakers(speakersFor.id, { me, swapped });
  if (ok) {
    $("speakers-dialog").hidden = true;
    host.afterImport();
  } else {
    ($("speakers-send") as HTMLButtonElement).disabled = false;
    status("speakers-status", "notyet", "The choice could not be saved. Close this and try again from Recent calls.");
  }
}

export function initImportUi(h: ImportHost): void {
  host = h;
  $("import-close").addEventListener("click", closeImportDialog);
  $("import-choose").addEventListener("click", () => void choose());
  $("import-run").addEventListener("click", () => void runChosen());
  api().onImportProgress((step) => status("import-status", "", step));
  $("speakers-close").addEventListener("click", () => ($("speakers-dialog").hidden = true));
  $("speakers-send").addEventListener("click", () => void sendChoice());
  $("speakers-dialog").addEventListener("change", markMine);
  for (const id of ["import-dialog", "speakers-dialog"]) {
    $(id).addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (id === "import-dialog") closeImportDialog();
      else $(id).hidden = true;
    });
  }
}
