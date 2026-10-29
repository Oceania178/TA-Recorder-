// TA Call Recorder — Electron main process.
// One recorder window + a floating bar, a tray icon, global shortcuts, one call at a time,
// crash-safe chunk files, the tacallrecorder:// protocol. See docs/plan.md (Steps 0 and 1).
// Never log command lines or deep links: they can carry a ticket (D-147).
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Notification, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RecorderController } from "./controller";
import { findDeepLinkArg, onDeepLink } from "./deepLinkHook";
import { IPC, type Command, type RecorderState, type StatusReport } from "./ipcTypes";
import { applySecurityPolicy, isOwnPage } from "./security";
import { ALREADY_RECORDING_MESSAGE } from "./sessionGuard";
import { runCaptureSelfTest, runCrashSelfTest } from "./smokeCapture";
import { commandForShortcut, SHORTCUTS, type ShortcutAction } from "./shortcuts";
import { RecorderTray } from "./tray";
import { createBarWindow, createRecorderWindow, sendCommandToRecorder } from "./windows";

const PROTOCOL = "tacallrecorder";
const SMOKE = process.argv.includes("--smoke");
const START_HIDDEN = process.argv.includes("--hidden");
const rendererDir = join(__dirname, "..", "renderer");
const preloadPath = join(__dirname, "preload.js");

if (SMOKE) {
  // The smoke run must not touch the real settings or recordings folder.
  const smokeDir = join(tmpdir(), "ta-call-recorder-smoke");
  mkdirSync(smokeDir, { recursive: true });
  app.setPath("userData", smokeDir);
}

let recorderWin: BrowserWindow | null = null;
let barWin: BrowserWindow | null = null;
let tray: RecorderTray | null = null;
let controller: RecorderController | null = null;
let quitting = false;
let toldAboutTray = false;
let rendererReady: () => void = () => undefined;
const rendererReadyPromise = new Promise<void>((done) => (rendererReady = done));

function main(): void {
  if (!SMOKE && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.setAppUserModelId("vn.vng.ta-call-recorder");
  registerProtocol();

  app.on("second-instance", (_event, argv) => {
    const url = findDeepLinkArg(argv);
    if (url) onDeepLink(url);
    showRecorder();
  });

  app.on("window-all-closed", () => {
    // Stay in the tray; quitting goes through the tray menu.
  });
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      quit();
    }
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());

  void app.whenReady().then(onReady);
}

function registerProtocol(): void {
  if (SMOKE) return;
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(PROTOCOL);
  } else if (process.argv.includes("--register-protocol")) {
    // Development only, on request: point tacallrecorder:// at this checkout.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(process.argv[1] ?? ".")]);
  }
}

async function onReady(): Promise<void> {
  applySecurityPolicy(rendererDir);

  controller = new RecorderController({
    userDataDir: app.getPath("userData"),
    documentsDir: SMOKE ? app.getPath("userData") : app.getPath("documents"),
    env: process.env,
    appVersion: app.getVersion(),
    onStateChange: onStateChange,
  });
  try {
    await controller.init();
  } catch {
    controller.addNotice("Could not check the recordings folder for unfinished recordings.");
  }

  registerIpc(controller);
  recorderWin = createRecorderWindow(rendererDir, preloadPath, !START_HIDDEN && !SMOKE);
  barWin = createBarWindow(rendererDir, preloadPath);
  wireRecorderWindow(recorderWin);

  tray = new RecorderTray({
    start: () => requestStart(),
    pauseOrResume: () => runShortcut("togglePause"),
    stop: () => command("stop"),
    open: () => showRecorder(),
    settings: () => {
      showRecorder();
      if (recorderWin) sendCommandToRecorder(recorderWin, "settings");
    },
    quit: () => quit(),
  });
  registerShortcuts();

  const firstLink = findDeepLinkArg(process.argv);
  if (firstLink) onDeepLink(firstLink);

  if (SMOKE) await finishSmoke();
}

async function finishSmoke(): Promise<void> {
  const timeout = new Promise<boolean>((done) => setTimeout(() => done(false), 15000));
  let ok = await Promise.race([rendererReadyPromise.then(() => true), timeout]);
  console.log(ok ? "smoke: recorder window loaded, tray and shortcuts registered" : "smoke: recorder window did not report ready");
  if (ok && process.argv.includes("--smoke-capture") && recorderWin && controller) {
    ok = await runCaptureSelfTest(recorderWin, controller);
    console.log(ok ? "smoke-capture: ok" : "smoke-capture: FAILED");
  }
  if (ok && process.argv.includes("--smoke-crash") && recorderWin && controller) {
    ok = await runCrashSelfTest(recorderWin, controller);
    console.log(ok ? "smoke-crash: ok" : "smoke-crash: FAILED");
  }
  globalShortcut.unregisterAll();
  tray?.destroy();
  app.exit(ok ? 0 : 1);
}

function onStateChange(state: RecorderState): void {
  tray?.update(state);
  if (!barWin || barWin.isDestroyed()) return;
  if (state === "idle") barWin.hide();
  else if (!barWin.isVisible()) barWin.showInactive();
}

function wireRecorderWindow(win: BrowserWindow): void {
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (!toldAboutTray) {
      toldAboutTray = true;
      tray?.notifyOnce("Still running", `TA Call Recorder keeps running in the tray. ${SHORTCUTS.toggleRecord.label} starts or stops a recording.`);
    }
  });
  win.webContents.on("render-process-gone", () => {
    // R6: the page that held the recorders is gone. Keep what reached the disk, then reload.
    void controller?.recorderLost().finally(() => {
      if (!win.isDestroyed()) void win.reload();
    });
  });
}

function showRecorder(): void {
  if (!recorderWin || recorderWin.isDestroyed()) return;
  if (recorderWin.isMinimized()) recorderWin.restore();
  recorderWin.show();
  recorderWin.focus();
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

/** Start, unless a call is already being recorded (D-39): then say so clearly. */
export function requestStart(): void {
  if (!controller || !recorderWin) return;
  if (controller.guard.isActive) {
    notify("TA Call Recorder", ALREADY_RECORDING_MESSAGE);
    return;
  }
  sendCommandToRecorder(recorderWin, "start");
}

function command(cmd: Command): void {
  if (cmd === "start") return requestStart();
  if (recorderWin) sendCommandToRecorder(recorderWin, cmd);
}

function runShortcut(action: ShortcutAction): void {
  if (!controller) return;
  const cmd = commandForShortcut(action, controller.guard.state);
  if (cmd) command(cmd);
}

function registerShortcuts(): void {
  for (const action of Object.keys(SHORTCUTS) as ShortcutAction[]) {
    const ok = globalShortcut.register(SHORTCUTS[action].accelerator, () => runShortcut(action));
    if (!ok) controller?.addNotice(`The shortcut ${SHORTCUTS[action].label} is used by another app, so it does not work here. Use the window or the tray.`);
  }
}

function waitUntilIdle(limitMs: number): Promise<void> {
  return new Promise((done) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (!controller?.guard.isActive || Date.now() - started > limitMs) {
        clearInterval(timer);
        done();
      }
    }, 200);
  });
}

function quit(): void {
  if (quitting) return;
  quitting = true;
  if (controller?.guard.isActive && recorderWin) {
    // Save the call before leaving. Whatever is not finalised in time is recovered at the next start (R6).
    sendCommandToRecorder(recorderWin, "stop");
    void waitUntilIdle(15000).then(() => app.quit());
  } else {
    app.quit();
  }
}

function fromOwnPage(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return isOwnPage(event.senderFrame?.url ?? "", rendererDir);
}

function registerIpc(c: RecorderController): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromOwnPage(event)) throw new Error("Refused");
      return fn(...args);
    });

  handle(IPC.beginCall, (mic) => {
    const m = (mic ?? {}) as Record<string, unknown>;
    return c.beginCall({ echoCancellation: m.echoCancellation === true, noiseSuppression: m.noiseSuppression === true, autoGainControl: m.autoGainControl === true });
  });
  handle(IPC.appendChunk, (callId, track, data) => c.appendChunk(callId, track, data));
  handle(IPC.markPause, (callId, kind, recordedMs) => c.markPause(callId, kind, recordedMs));
  handle(IPC.endCall, (callId, recordedMs) => c.endCall(callId, recordedMs));
  handle(IPC.abortCall, (callId) => c.abortCall(callId));
  handle(IPC.getSettings, () => c.settingsView());
  handle(IPC.setMicProcessing, async (on) => {
    await c.setMicProcessing(on === true);
    return c.settingsView();
  });
  handle(IPC.chooseDir, async () => {
    if (!recorderWin) return c.settingsView();
    const picked = await dialog.showOpenDialog(recorderWin, { title: "Choose the recordings folder", properties: ["openDirectory", "createDirectory"], defaultPath: c.recordingsDir() });
    const problem = picked.canceled || !picked.filePaths[0] ? null : await c.setRecordingsDir(picked.filePaths[0]);
    const view = c.settingsView();
    if (problem) view.notices.unshift(problem);
    return view;
  });
  handle(IPC.openFolder, async () => {
    if (c.dirProblem()) return;
    await mkdir(c.recordingsDir(), { recursive: true });
    await shell.openPath(c.recordingsDir());
  });

  ipcMain.on(IPC.ready, (event) => {
    if (fromOwnPage(event) && event.sender === recorderWin?.webContents) rendererReady();
  });
  ipcMain.on(IPC.status, (event, status: StatusReport) => {
    if (!fromOwnPage(event) || event.sender !== recorderWin?.webContents) return;
    if (status?.state === "recording") c.noteCaptureStarted();
    if (status?.state === "stopping") c.noteStopping();
    if (barWin && !barWin.isDestroyed()) barWin.webContents.send(IPC.statusToBar, status);
  });
  ipcMain.on(IPC.barCommand, (event, cmd: unknown) => {
    if (!fromOwnPage(event)) return;
    if (cmd === "open") showRecorder();
    else if (cmd === "pause" || cmd === "resume" || cmd === "stop") command(cmd);
  });
}

main();
