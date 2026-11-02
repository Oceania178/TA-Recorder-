// The first-run set-up check (D-132, spec §8.23): 5 steps, each shows "pass" or "not yet" and how to fix it.
// Shown at the first start until finished; again from the tray ("Set-up check…") or Settings.
//   1 notice → "I understand"   2 mic permission   3 both meters move   4 Solace address   5 3CX test dial (optional)
import type { SettingsView } from "../main/ipcTypes";
import { api } from "./bridge";
import { startSoundCheck, type SoundCheck } from "./soundCheck";

const STEPS = 5;
const MOVED = 0.15;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface WizardHost {
  isIdle(): boolean;
  settingsChanged(view: SettingsView): void;
}

let host: WizardHost;
let step = 1;
const pass: boolean[] = new Array(STEPS + 1).fill(false);
let sound: SoundCheck | null = null;
let soundTimer: ReturnType<typeof setInterval> | null = null;
let peaks: [number, number] = [0, 0];

function status(n: number, ok: boolean, text: string): void {
  const el = $(`wz-status-${n}`);
  el.textContent = `${ok ? "Pass" : "Not yet"} — ${text}`;
  el.className = `wizard-status ${ok ? "pass" : "notyet"}`;
  pass[n] = ok;
  render();
}

function render(): void {
  document.querySelectorAll<HTMLElement>("#wizard-steps li").forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle("current", n === step);
    li.classList.toggle("pass", pass[n]);
    if (n === step) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
  document.querySelectorAll<HTMLElement>(".wizard-panel").forEach((p) => (p.hidden = Number(p.dataset.panel) !== step));
  ($("wz-back") as HTMLButtonElement).disabled = step === 1;
  const next = $("wz-next") as HTMLButtonElement;
  next.textContent = step === STEPS ? "Finish" : "Next";
  next.disabled = step === 1 && !pass[1];
}

async function stopSound(): Promise<void> {
  if (soundTimer) clearInterval(soundTimer);
  soundTimer = null;
  const s = sound;
  sound = null;
  ($("wz-sound-start") as HTMLButtonElement).disabled = false;
  ($("wz-beep") as HTMLButtonElement).disabled = true;
  ($("wz-sound-stop") as HTMLButtonElement).disabled = true;
  $("wz-meter-left").style.width = "0%";
  $("wz-meter-right").style.width = "0%";
  await s?.stop();
}

async function go(to: number): Promise<void> {
  if (step === 3 && to !== 3) await stopSound();
  step = Math.max(1, Math.min(STEPS, to));
  render();
  // Keyboard and screen-reader users land on the new step's title.
  document.querySelector<HTMLElement>(`.wizard-panel[data-panel="${step}"] h3`)?.focus();
}

/** "Later" (or Esc): close without accepting anything (D-162: closing is not "I understand"). */
function closeWizard(): void {
  void stopSound();
  $("wizard").hidden = true;
  $("btn-wizard").focus();
}

// ---- step 1: notice ----
async function accept(): Promise<void> {
  host.settingsChanged(await api().acceptNotice());
  status(1, true, "you have read what the app records and where it goes.");
}

// ---- step 2: mic ----
async function testMic(): Promise<void> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    s.getTracks().forEach((t) => t.stop());
    $("wz-mic-settings").hidden = true;
    $("wz-mic-fix").hidden = true;
    status(2, true, "the microphone opens.");
  } catch {
    $("wz-mic-settings").hidden = false;
    $("wz-mic-fix").hidden = false;
    status(2, false, "Windows blocked the microphone. Open the Windows microphone settings, allow it, then test again.");
  }
}

// ---- step 3: sound check ----
async function startSound(): Promise<void> {
  if (!host.isIdle()) {
    status(3, false, "finish the current recording first.");
    return;
  }
  try {
    sound = await startSoundCheck();
  } catch (e) {
    status(3, false, e instanceof Error ? e.message : "the devices could not be opened.");
    $("wz-sound-fix").hidden = false;
    return;
  }
  peaks = [0, 0];
  ($("wz-sound-start") as HTMLButtonElement).disabled = true;
  ($("wz-beep") as HTMLButtonElement).disabled = false;
  ($("wz-sound-stop") as HTMLButtonElement).disabled = false;
  status(3, false, "say a few words, then press Play beep.");
  soundTimer = setInterval(() => {
    if (!sound) return;
    const [l, r] = sound.levels();
    peaks = [Math.max(peaks[0], l), Math.max(peaks[1], r)];
    $("wz-meter-left").style.width = `${Math.round(l * 100)}%`;
    $("wz-meter-right").style.width = `${Math.round(r * 100)}%`;
    if (!pass[3] && peaks[0] > MOVED && peaks[1] > MOVED) {
      $("wz-sound-fix").hidden = true;
      status(3, true, "both meters moved: your voice on the left, what you hear on the right.");
    }
  }, 100);
  setTimeout(() => {
    if (sound && !pass[3]) $("wz-sound-fix").hidden = false;
  }, 15_000);
}

// ---- step 4: Solace address ----
async function testSolace(): Promise<void> {
  const raw = ($("wz-solace-url") as HTMLInputElement).value;
  const saved = await api().setSolaceAddress(raw);
  host.settingsChanged(saved.view);
  if (saved.problem) {
    status(4, false, saved.problem);
    return;
  }
  status(4, false, "testing…");
  const r = await api().testSolaceAddress(saved.view.solaceBaseUrl ?? raw);
  status(4, r.ok, r.message);
}

// ---- step 5: 3CX ----
async function testDial(): Promise<void> {
  const ok = await api().testDial(($("wz-dial-number") as HTMLInputElement).value);
  if (!ok) {
    status(5, false, "enter a phone number (digits only, a + in front is fine).");
    return;
  }
  $("wz-dial-ok").hidden = false;
  status(5, false, "did 3CX open with that number? If another app opened, set 3CX as the default for TEL links and try again.");
}

async function finish(): Promise<void> {
  await stopSound();
  host.settingsChanged(await api().finishWizard());
  $("wizard").hidden = true;
}

export function openWizard(view: SettingsView): void {
  pass[1] = view.noticeAccepted;
  if (view.noticeAccepted) status(1, true, "you have read what the app records and where it goes.");
  ($("wz-solace-url") as HTMLInputElement).value = view.solaceBaseUrl ?? "";
  $("wizard").hidden = false;
  void go(view.noticeAccepted ? 2 : 1);
}

export function initWizard(h: WizardHost): void {
  host = h;
  $("wizard-close").addEventListener("click", closeWizard);
  $("wizard").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeWizard();
    } else if (e.key === "Tab") {
      // Keep Tab inside the dialog (aria-modal): wrap from the last control to the first and back.
      const all = Array.from(document.querySelectorAll<HTMLElement>(".wizard button, .wizard input")).filter((x) => !x.hasAttribute("disabled") && x.offsetParent !== null);
      const first = all[0];
      const last = all[all.length - 1];
      if (e.shiftKey && (document.activeElement === first || !all.includes(document.activeElement as HTMLElement))) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  });
  document.querySelectorAll<HTMLElement>(".wizard-panel h3").forEach((h) => (h.tabIndex = -1));
  $("wz-back").addEventListener("click", () => void go(step - 1));
  $("wz-next").addEventListener("click", () => void (step === STEPS ? finish() : go(step + 1)));
  $("wz-accept").addEventListener("click", () => void accept());
  $("wz-mic-test").addEventListener("click", () => void testMic());
  $("wz-mic-settings").addEventListener("click", () => void api().openMicSettings());
  $("wz-sound-start").addEventListener("click", () => void startSound());
  $("wz-beep").addEventListener("click", () => sound?.beep());
  $("wz-sound-stop").addEventListener("click", () => void stopSound());
  $("wz-solace-test").addEventListener("click", () => void testSolace());
  $("wz-dial").addEventListener("click", () => void testDial());
  $("wz-dial-ok").addEventListener("click", () => status(5, true, "3CX dials the numbers Solace sends."));
  render();
}
