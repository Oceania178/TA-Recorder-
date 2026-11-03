// The recorder window: Start / Pause / Resume / Stop, timer, meters, device check, settings, recent calls and
// the set-up check. The audio work itself lives in capture.ts; this file only wires it to the screen and to main.
import type { RecorderState, SettingsView, Track } from "../main/ipcTypes";
import { api } from "./bridge";
import { listDevices, startCapture, type CaptureSession } from "./capture";
import { ElapsedClock, formatElapsed } from "./elapsedClock";
import { checkOutputDevices } from "./outputDevices";
import { initRecentCalls, refreshCalls } from "./recentCalls";
import { initSettingsPanel, renderSettingsPanel } from "./settingsPanel";
import { SilenceWatch } from "./silenceWatch";
import { LONG_CALL_STOPPED, LONG_CALL_WARNING, longCallStatus } from "./longCall";
import { initWizard, openWizard } from "./wizard";
import { isInCall } from "./inCall";
import { initImportUi, openImportDialog, openSpeakerDialog } from "./importUi";
import { importButton } from "./importText";
import { folderBanner, isStaleNoticeMessage, NOTICE_FIRST_MESSAGE, startHint, startIsPrimary } from "./recorderCopy";

const TICK_MS = 200;
const SILENCE_LIMIT_MS = 60_000;
const SILENCE_THRESHOLD = 0.08;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let state: RecorderState = "idle";
let session: CaptureSession | null = null;
let callId: string | null = null;
let chains: Record<Track, Promise<void>> = { stereo: Promise.resolve(), left: Promise.resolve(), right: Promise.resolve() };
let settings: SettingsView | null = null;
let levels: [number, number] = [0, 0];
let warning: string | null = null;
/** P3: the call being recorded is linked to Solace; null while idle. */
let linkedNow: boolean | null = null;
const clock = new ElapsedClock();
const silence = [new SilenceWatch({ limitMs: SILENCE_LIMIT_MS, threshold: SILENCE_THRESHOLD }), new SilenceWatch({ limitMs: SILENCE_LIMIT_MS, threshold: SILENCE_THRESHOLD })];

const STATUS_TEXT: Record<RecorderState, string> = {
  idle: "Ready",
  starting: "Starting…",
  recording: "Recording",
  paused: "Paused",
  stopping: "Saving…",
};

const TEST_MODE_OFF = "Start the call from Solace (Call & record). To record without Solace, turn on Test mode in Settings.";

function showMessage(text: string, kind: "info" | "error" | "ok" | "warn" = "info"): void {
  const el = $("message");
  el.textContent = text;
  el.className = `message ${kind}`;
  el.hidden = !text;
}

function showLinkState(linked: boolean | null): void {
  const el = $("link-state");
  el.hidden = linked === null;
  el.textContent = linked ? "Linked to Solace" : "Local only — not linked to Solace";
  el.className = `link-state ${linked ? "linked" : "local"}`;
}

function setState(next: RecorderState): void {
  state = next;
  document.body.dataset.state = next;
  document.body.classList.toggle("in-call", isInCall(next));
  $("status").textContent = STATUS_TEXT[next];
  ($("btn-start") as HTMLButtonElement).disabled = next !== "idle" || !!settings?.dirProblem;
  ($("btn-pause") as HTMLButtonElement).disabled = next !== "recording" && next !== "paused";
  ($("btn-pause") as HTMLButtonElement).textContent = next === "paused" ? "Resume" : "Pause";
  ($("btn-stop") as HTMLButtonElement).disabled = next !== "recording" && next !== "paused";
  ($("mic-processing") as HTMLInputElement).disabled = next !== "idle";
  ($("test-mode") as HTMLInputElement).disabled = next !== "idle";
  ($("btn-change-dir") as HTMLButtonElement).disabled = next !== "idle";
  // D-171: "Import a recording…" (idle, Test mode) or "…instead…" (a live Solace call).
  const imp = importButton(next, linkedNow, settings?.testMode === true);
  const btn = $("btn-import") as HTMLButtonElement;
  btn.hidden = !imp.visible;
  btn.textContent = imp.label;
  btn.disabled = !imp.enabled || !!settings?.dirProblem;
  report();
}

/** D-171: the TA replaces this live Solace recording by an imported file: stop it, delete it, keep the session. */
async function discardForImport(): Promise<boolean> {
  if ((state !== "recording" && state !== "paused") || !session || !callId || linkedNow !== true) return false;
  const id = callId;
  const s = session;
  setState("stopping");
  try {
    await s.stop();
  } catch {
    // the recording is thrown away anyway
  }
  await Promise.all(Object.values(chains)).catch(() => undefined);
  const r = await api().discardForImport(id);
  session = null;
  callId = null;
  levels = [0, 0];
  warning = null;
  linkedNow = null;
  clock.reset();
  setState("idle");
  showLinkState(null);
  updateMeters();
  showMessage(r.ok ? "The live recording was stopped and deleted. The imported file is used for this Solace call." : (r.message ?? "The live recording could not be replaced."), r.ok ? "info" : "error");
  return r.ok;
}

function report(): void {
  api().reportStatus({ state, elapsedMs: clock.elapsed(performance.now()), levels, warning, testMode: settings?.testMode === true, linked: linkedNow });
}

function micSettings(on: boolean) {
  return { echoCancellation: on, noiseSuppression: on, autoGainControl: on };
}

/** `linked`: pressed by a Solace link (main armed the session); `local`: the button, tray or a shortcut. */
async function start(intent: "local" | "linked" = "local"): Promise<void> {
  if (settings && !settings.noticeAccepted) {
    // D-126 (APP review I1): no recording before the notice is accepted.
    showMessage(NOTICE_FIRST_MESSAGE, "error");
    openWizard(settings);
    return;
  }
  if (intent === "local" && settings && !settings.testMode) {
    // D-165: without Test mode the app records only when opened from Solace's button.
    showMessage(TEST_MODE_OFF, "error");
    return;
  }
  if (state !== "idle") {
    showMessage("Already recording a call. Stop the current recording before starting a new one (one call at a time).", "error");
    return;
  }
  if (!settings || settings.dirProblem) {
    showMessage(settings?.dirProblem ?? "Settings are still loading.", "error");
    return;
  }
  setState("starting");
  showMessage("Starting…");
  const micOn = settings.micProcessing;
  const begin = await api().beginCall(micSettings(micOn), intent);
  if (!begin.ok) {
    setState("idle");
    showMessage(begin.message, "error");
    if (begin.code === "notice" && settings) openWizard(settings);
    return;
  }
  const id = begin.callId;
  callId = id;
  chains = { stereo: Promise.resolve(), left: Promise.resolve(), right: Promise.resolve() };
  try {
    session = await startCapture({
      micProcessing: micOn,
      fakeAudio: settings?.e2eAudio === true,
      onChunk: (track, blob) => {
        chains[track] = chains[track]
          .then(async () => api().appendChunk(id, track, await blob.arrayBuffer()))
          .catch(() => showMessage("Part of the audio could not be written to disk. Check free space in the recordings folder.", "error"));
      },
      onFatal: (message) => {
        showMessage(message, "error");
        void stop();
      },
    });
  } catch (err) {
    await api().abortCall(id);
    callId = null;
    setState("idle");
    showMessage(err instanceof Error ? err.message : "Recording could not start.", "error");
    return;
  }
  const now = performance.now();
  clock.start(now);
  silence.forEach((s) => s.reset(now));
  warning = null;
  linkedNow = begin.linked;
  setState("recording");
  showLinkState(begin.linked);
  showMessage(
    begin.linked
      ? begin.dialMode === "self_dial"
        ? `Recording Solace call ${id}. Dial the candidate yourself.`
        : `Recording Solace call ${id}.`
      : `Recording call ${id}. Local only — not linked to Solace: it is transcribed on this laptop and never sent.`,
  );
  void refreshDevices();
}

async function pause(): Promise<void> {
  if (state !== "recording" || !session || !callId) return;
  const now = performance.now();
  session.pause();
  clock.pause(now);
  setState("paused");
  await api().markPause(callId, "pause", clock.elapsed(now));
}

async function resume(): Promise<void> {
  if (state !== "paused" || !session || !callId) return;
  const now = performance.now();
  session.resume();
  clock.resume(now);
  silence.forEach((s) => s.reset(now));
  setState("recording");
  await api().markPause(callId, "resume", clock.elapsed(now));
}

async function stop(): Promise<void> {
  if ((state !== "recording" && state !== "paused") || !session || !callId) return;
  const id = callId;
  const recordedMs = clock.elapsed(performance.now());
  setState("stopping");
  try {
    await session.stop();
  } catch {
    // keep going: whatever was handed over is saved below
  }
  await Promise.all(Object.values(chains));
  const result = await api().endCall(id, recordedMs);
  session = null;
  callId = null;
  levels = [0, 0];
  warning = null;
  linkedNow = null;
  clock.reset();
  setState("idle");
  showLinkState(null);
  updateMeters();
  void refreshCalls();
  if (result.ok) {
    showMessage(`Saved call ${id} (${formatElapsed(recordedMs)}). It is transcribed next — see Recent calls.`, "ok");
    $("last-saved").textContent = `Last saved: ${id}`;
  } else {
    showMessage(result.message, "error");
  }
}

function updateMeters(): void {
  ($("meter-left") as HTMLElement).style.width = `${Math.round(levels[0] * 100)}%`;
  ($("meter-right") as HTMLElement).style.width = `${Math.round(levels[1] * 100)}%`;
}

function tick(): void {
  const now = performance.now();
  if (session && (state === "recording" || state === "paused")) {
    levels = state === "paused" ? [0, 0] : session.levels();
    const long = longCallStatus(clock.elapsed(now));
    if (long === "stop") {
      void stop().then(() => showMessage(LONG_CALL_STOPPED, "warn"));
      return;
    }
    if (state === "recording") {
      const micSilent = silence[0].update(now, levels[0]);
      const otherSilent = silence[1].update(now, levels[1]);
      warning = micSilent
        ? "No sound from your microphone for over a minute. Is the right mic selected and unmuted?"
        : otherSilent
          ? "No sound from the other side for over a minute. Is the call playing on the device the app records? See Device check."
          : null;
      if (long === "warn") warning = LONG_CALL_WARNING;
    }
  }
  $("timer").textContent = formatElapsed(clock.elapsed(now));
  $("warning").textContent = warning ?? "";
  $("warning").hidden = !warning;
  updateMeters();
  report();
}

async function refreshDevices(): Promise<void> {
  try {
    const result = checkOutputDevices(await listDevices());
    $("device-recorded").textContent = result.recordedOutput ?? "unknown";
    const list = $("device-list");
    list.replaceChildren(...result.outputs.map((name) => Object.assign(document.createElement("li"), { textContent: name })));
    const warn = $("device-warning");
    warn.textContent = result.warnings.join(" ");
    warn.hidden = result.warnings.length === 0;
    // P1: a device warning keeps Device check on screen during a call.
    $("devices").classList.toggle("has-warning", result.warnings.length > 0);
  } catch {
    $("device-recorded").textContent = "unknown";
    $("device-warning").textContent = "The device list could not be read. Press Check again; if it stays, restart the app.";
    $("device-warning").hidden = false;
    $("devices").classList.add("has-warning");
  }
}

function renderSettings(view: SettingsView): void {
  settings = view;
  $("dir-path").textContent = view.recordingsDir;
  $("dir-problem").textContent = view.dirProblem ?? "";
  $("dir-problem").hidden = !view.dirProblem;
  ($("mic-processing") as HTMLInputElement).checked = view.micProcessing;
  ($("test-mode") as HTMLInputElement).checked = view.testMode;
  $("test-mode-badge").hidden = !view.testMode;
  $("shortcut-record").textContent = view.shortcuts.toggleRecord;
  $("shortcut-pause").textContent = view.shortcuts.togglePause;
  $("notices").replaceChildren(...view.notices.map((n) => Object.assign(document.createElement("li"), { textContent: n })));
  $("notices").hidden = view.notices.length === 0;
  renderSettingsPanel(view);
  // UX pass: the next step under Start, Start blue only when it can record, a folder problem next to Start.
  $("start-hint").textContent = startHint(view.testMode, view.shortcuts.toggleRecord);
  $("btn-start").classList.toggle("primary", startIsPrimary(view.testMode));
  const banner = folderBanner(view.dirProblem);
  $("dir-problem-main-text").textContent = banner ?? "";
  $("dir-problem-main").hidden = !banner;
  if (isStaleNoticeMessage($("message").textContent ?? "", view.noticeAccepted)) showMessage("");
  setState(state);
}

/** Scroll to a Settings field and put the cursor there. */
function goToSetting(id: string): void {
  const target = $(id);
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.focus({ preventScroll: true });
}

function runCommand(cmd: string): void {
  if (cmd === "start") void start("local");
  else if (cmd === "startLinked") void start("linked");
  else if (cmd === "stop") void stop();
  else if (cmd === "pause") void pause();
  else if (cmd === "resume") void resume();
  else if (cmd === "settings") $("settings").scrollIntoView({ behavior: "smooth" });
  else if (cmd === "calls") $("calls").scrollIntoView({ behavior: "smooth" });
  else if (cmd === "import") openImportDialog();
  else if (cmd === "speakers") void openSpeakerDialog();
}

async function init(): Promise<void> {
  window.__taRecorderCommand = runCommand;
  $("btn-start").addEventListener("click", () => void start("local"));
  $("btn-pause").addEventListener("click", () => void (state === "paused" ? resume() : pause()));
  $("btn-stop").addEventListener("click", () => void stop());
  $("btn-check-devices").addEventListener("click", () => void refreshDevices());
  $("btn-dir-settings").addEventListener("click", () => goToSetting("btn-change-dir"));
  $("btn-key-settings").addEventListener("click", () => goToSetting("gemini-key"));
  $("btn-change-dir").addEventListener("click", async () => renderSettings(await api().chooseRecordingsDir()));
  $("btn-open-dir").addEventListener("click", () => void api().openRecordingsFolder());
  $("mic-processing").addEventListener("change", async (e) => renderSettings(await api().setMicProcessing((e.target as HTMLInputElement).checked)));
  $("test-mode").addEventListener("change", async (e) => {
    const r = await api().setTestMode((e.target as HTMLInputElement).checked);
    renderSettings(r.view);
    $("test-mode-problem").textContent = r.problem ?? "";
    $("test-mode-problem").hidden = !r.problem;
  });
  navigator.mediaDevices?.addEventListener?.("devicechange", () => void refreshDevices());
  initSettingsPanel(renderSettings);
  initWizard({ isIdle: () => state === "idle", settingsChanged: renderSettings });
  $("btn-wizard").addEventListener("click", () => settings && openWizard(settings));
  api().onShowWizard(() => {
    if (settings) openWizard(settings);
  });
  api().onAppMessage((m) => showMessage(m.text, m.kind));

  renderSettings(await api().getSettings());
  initRecentCalls((id) => void openSpeakerDialog(id));
  initImportUi({
    liveLinked: () => linkedNow === true && (state === "recording" || state === "paused"),
    discardLive: discardForImport,
    afterImport: () => void refreshCalls(),
  });
  $("btn-import").addEventListener("click", () => openImportDialog());
  setState("idle");
  setInterval(tick, TICK_MS);
  void refreshDevices();
  api().rendererReady();
}

void init();
