// TA Call Recorder — Electron main process.
// One recorder window + a floating bar, a tray icon, global shortcuts, one call at a time,
// crash-safe chunk files, the tacallrecorder:// protocol (Steps 0, 1); after Stop the transcription queue,
// Gemini, Solace and the 3-day delete (Step 2); Solace's deep link with the ticket check (Step 5); settings and
// the first-run wizard (D-132). See docs/plan.md.
// Never log command lines or deep links: they can carry a ticket (D-147). Logs are counts and stages only.
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Notification, safeStorage, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import { createServer } from "node:http";
import { checkTicket, DEFAULT_GEMINI_MODEL, type FetchLike } from "../core";
import { AppLog } from "./appLog";
import { CallJobs } from "./callJobs";
import { callRows } from "./callsView";
import { ensureCleanupTask, keepCleanupTask, type CommandRunner } from "./cleanupTask";
import { RecorderController } from "./controller";
import { DecoderClient, decodeWebmToPcmFile } from "./decoderClient";
import { DecoderWindow } from "./decoderWindow";
import { DeepLinkFlow, type LinkOutcome } from "./deepLinkFlow";
import { findDeepLinkArg, onDeepLink, setDeepLinkHandler } from "./deepLinkHook";
import { createNetFetch } from "./netFetch";
import { handleSecondInstance } from "./secondInstance";
import { requestLocalStart } from "./startGate";
import { IPC, type AppMessage, type Command, type RecorderState, type SettingsView, type StatusReport } from "./ipcTypes";
import { deletePcmFiles, makeOpenPcm } from "./pcmFiles";
import { SecretStore } from "./secretStore";
import { applySecurityPolicy, isOwnPage } from "./security";
import { clearGeminiKey, setGeminiKey, setGeminiModel, setSolaceAddress, type SettingsHost } from "./settingsActions";
import { runCaptureSelfTest, runCrashSelfTest } from "./smokeCapture";
import { commandForShortcut, SHORTCUTS, type ShortcutAction } from "./shortcuts";
import { isPurgeMode, isSweepMode, runHeadlessSweep, runUninstallPurge } from "./sweepMode";
import { SweepHandover } from "./sweepHandover";
import { RecorderTray } from "./tray";
import { telLink, testSolaceAddress, WINDOWS_MIC_SETTINGS } from "./wizardChecks";
import { createBarWindow, createRecorderWindow, sendCommandToRecorder } from "./windows";

const PROTOCOL = "tacallrecorder";
const SMOKE = process.argv.includes("--smoke");
const SWEEP = isSweepMode(process.argv);
const PURGE = isPurgeMode(process.argv);
const START_HIDDEN = process.argv.includes("--hidden");
/** Development only: allows http://localhost as the Solace address. Ignored in the installed app. */
const DEV = !app.isPackaged && process.argv.includes("--dev");
const rendererDir = join(__dirname, "..", "renderer");
const preloadPath = join(__dirname, "preload.js");
const barPreloadPath = join(__dirname, "barPreload.js");
const decoderPreloadPath = join(__dirname, "decoderPreload.js");
const SWEEP_EVERY_MS = 3600_000;

if (SMOKE) {
  // The smoke run must not touch the real settings or recordings folder.
  const smokeDir = join(tmpdir(), "ta-call-recorder-smoke");
  mkdirSync(smokeDir, { recursive: true });
  app.setPath("userData", smokeDir);
}

const log = new AppLog({ file: join(app.getPath("userData"), "app.log") });
/** Chromium's network stack in its own session (APP review M12); set once the app is ready. */
let chromiumFetch: FetchLike | null = null;
const netFetch: FetchLike = (url, init) => {
  if (!chromiumFetch) return Promise.reject(new Error("The network is not ready yet"));
  return chromiumFetch(url, init);
};

let recorderWin: BrowserWindow | null = null;
let barWin: BrowserWindow | null = null;
let tray: RecorderTray | null = null;
let controller: RecorderController | null = null;
let secrets: SecretStore | null = null;
let jobs: CallJobs | null = null;
let decoderWin: DecoderWindow | null = null;
let decoder: DecoderClient | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let quitting = false;
let toldAboutTray = false;
let rendererReady: () => void = () => undefined;
const rendererReadyPromise = new Promise<void>((done) => (rendererReady = done));

function main(): void {
  if (PURGE) return purgeAndExit();
  if (SWEEP) return sweepAndExit();
  if (!SMOKE && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.setAppUserModelId("vn.vng.ta-call-recorder");
  registerProtocol();

  app.on("second-instance", (_event, argv) => {
    handleSecondInstance(argv, {
      sweep: () => void runSweep(),
      deepLink: (url) => onDeepLink(url),
      show: () => showRecorder(),
      log: (e, f) => log.event(e, f),
    });
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
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    jobs?.close();
    decoderWin?.close();
    if (sweepTimer) clearInterval(sweepTimer);
  });

  void app.whenReady().then(onReady);
}

/**
 * `--uninstall-purge` (the uninstaller, a real uninstall only): delete every recording of ours and the app's
 * data (settings, queue, log, Gemini key, tickets), then exit. Nothing is logged: the log is deleted too.
 */
function purgeAndExit(): void {
  void runUninstallPurge({ userDataDir: app.getPath("userData"), documentsDir: app.getPath("documents"), env: process.env })
    .catch(() => undefined)
    .finally(() => app.exit(0));
}

/**
 * `--sweep` (the Task Scheduler task, D-140): delete expired calls without any window, then exit. It holds
 * the single-instance lock while it runs, so the app is not running and no job can be busy (APP review I2d).
 */
function sweepAndExit(): void {
  if (!app.requestSingleInstanceLock()) {
    // The app is running: it received this as a second instance and sweeps itself.
    app.exit(0);
    return;
  }
  // A start or a Solace link during the sweep lands here: remember it and start the app with it afterwards (m-R5).
  const handover = new SweepHandover();
  app.on("second-instance", (_event, argv) => handover.noteRequest(argv));
  void runHeadlessSweep({
    userDataDir: app.getPath("userData"),
    documentsDir: app.getPath("documents"),
    env: process.env,
    nowMs: Date.now(),
    log: (e, f) => log.event(e, f),
  })
    .catch(() => log.event("retention.sweep_failed", {}))
    .finally(async () => {
      // second-instance is delivered only after "ready"; give a request that just arrived a moment to land.
      await app.whenReady();
      await new Promise((done) => setTimeout(done, 300));
      const args = handover.relaunchArgs();
      log.event("retention.sweep_handover", { relaunch: args !== null });
      await log.flush();
      app.releaseSingleInstanceLock();
      if (args) app.relaunch({ args });
      app.exit(0);
    });
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
  chromiumFetch = createNetFetch();
  log.event("app.start", { smoke: SMOKE, dev: DEV });
  secrets = new SecretStore({ dir: join(app.getPath("userData"), "secrets"), crypto: safeStorage });

  controller = new RecorderController({
    userDataDir: app.getPath("userData"),
    documentsDir: SMOKE ? app.getPath("userData") : app.getPath("documents"),
    env: process.env,
    appVersion: app.getVersion(),
    onStateChange: onStateChange,
    // Step 2: every saved call goes to the queue. Queue it now; the work runs after Stop has answered.
    onCallSaved: SMOKE
      ? undefined
      : async (call) => {
          if (!jobs) return;
          await jobs.enqueue(call);
          void jobs.drain();
        },
  });
  const c = controller;

  try {
    jobs = await openJobs(c, secrets);
  } catch {
    log.event("queue.open_failed", {});
    c.addNotice("The transcription queue could not be opened. Recording still works; restart the app to transcribe.");
  }
  try {
    await c.init();
  } catch {
    c.addNotice("Could not check the recordings folder for unfinished recordings.");
  }
  // The self-tests record into a throwaway folder; the notice (D-126) is a decision for a person, not a test.
  if (SMOKE && !c.noticeAccepted()) await c.updateSettings({ noticeAcceptedAt: new Date().toISOString() });
  void secrets.pruneExpired(Date.now()).catch(() => undefined);

  registerIpc(c);
  recorderWin = createRecorderWindow(rendererDir, preloadPath, !START_HIDDEN && !SMOKE);
  barWin = createBarWindow(rendererDir, barPreloadPath);
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
    wizard: () => showWizard(),
    quit: () => quit(),
  });
  registerShortcuts();

  if (!SMOKE) {
    await runSweep();
    sweepTimer = setInterval(() => void runSweep(), SWEEP_EVERY_MS);
    void jobs?.drain();
    void ensureCleanupTaskOnce(c);
    wireDeepLinks(c);
    if (!c.appSettings.wizardDoneAt) void rendererReadyPromise.then(() => showWizard());
  }

  const firstLink = findDeepLinkArg(process.argv);
  if (firstLink) onDeepLink(firstLink);

  if (SMOKE) await finishSmoke();
}

// ---------- Step 2: the queue, the decoder, retention ----------

async function openJobs(c: RecorderController, s: SecretStore): Promise<CallJobs> {
  decoderWin = new DecoderWindow(rendererDir, decoderPreloadPath);
  decoder = new DecoderClient(decoderWin);
  const client = decoder;
  return CallJobs.open({
    queueFile: join(app.getPath("userData"), "queue.json"),
    secrets: s,
    getBaseUrl: () => c.appSettings.solaceBaseUrl,
    getModel: () => c.appSettings.geminiModel ?? DEFAULT_GEMINI_MODEL,
    fetch: netFetch,
    openPcm: makeOpenPcm((webm, pcm) => decodeWebmToPcmFile(client, webm, pcm)),
    afterTranscript: (job) => deletePcmFiles(job.folder, job.id),
    appVersion: app.getVersion(),
    dev: DEV,
    log: (e, f) => log.event(e, f),
    onChange: () => callsChanged(),
  });
}

/** D-140: delete calls older than 3 days in every recordings folder used so far (at start-up, then hourly). */
async function runSweep(): Promise<void> {
  if (!controller || !jobs) return;
  try {
    await jobs.sweep(controller.knownRecordingsDirs(), controller.activeCallId);
  } catch {
    log.event("retention.sweep_failed", {});
  }
}

const runCommand: CommandRunner = (file, args) =>
  new Promise((done) => {
    execFile(file, [...args], { windowsHide: true, timeout: 30_000 }, (err) => {
      done({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0 });
    });
  });

/**
 * The per-user Task Scheduler task that deletes old calls while the app is closed (D-140). Created by the
 * installed app on its first run (again after an update); in development only with --register-cleanup-task.
 */
async function ensureCleanupTaskOnce(c: RecorderController): Promise<void> {
  const devRequested = !app.isPackaged && process.argv.includes("--register-cleanup-task");
  if (!app.isPackaged && !devRequested) return;
  const forThis = `${process.execPath}|${app.getVersion()}`;
  const user = userInfo().username;
  const domain = process.env.USERDOMAIN?.trim();
  // At every start: (re-)create it when it was made for another version, or when it is missing (M8).
  const r = await keepCleanupTask({
    run: runCommand,
    recordedFor: c.appSettings.cleanupTaskFor,
    forThis,
    create: () =>
      ensureCleanupTask({
        run: runCommand,
        exePath: process.execPath,
        extraArgs: app.isPackaged ? [] : [resolve(process.argv[1] ?? ".")],
        userId: domain ? `${domain}\\${user}` : user,
        xmlFile: join(app.getPath("temp"), `ta-call-recorder-cleanup-${process.pid}.xml`),
      }),
  });
  log.event("cleanup_task.check", { ok: r.ok, created: r.created });
  if (r.created) await c.updateSettings({ cleanupTaskFor: forThis });
  else if (!r.ok) c.addNotice("The daily clean-up of old recordings could not be scheduled in Windows. The app still deletes them while it runs.");
}

// ---------- Step 5: Solace's deep link ----------

function wireDeepLinks(c: RecorderController): void {
  const s = secrets;
  if (!s) return;
  const flow = new DeepLinkFlow({
    noticeAccepted: () => c.noticeAccepted(),
    isRecording: () => c.guard.isActive,
    getBaseUrl: () => c.appSettings.solaceBaseUrl,
    checkTicket: (baseUrl, sessionId, ticket) => checkTicket({ fetch: netFetch, dev: DEV }, baseUrl, sessionId, ticket),
    tickets: { held: (id) => s.heldTicket(id), save: (id, ticket, held) => s.saveTicket(id, ticket, held) },
    alreadyRecorded: (id) => c.hasCall(id) || !!jobs?.get(id),
    start: (session) => {
      c.armLinkedCall(session);
      showRecorder();
      // On a first launch from the link the page may still be loading: press Start once it is ready.
      void rendererReadyPromise.then(() => {
        if (recorderWin) sendCommandToRecorder(recorderWin, "startLinked");
      });
    },
    log: (e, f) => log.event(e, f),
  });
  setDeepLinkHandler((url) => {
    void flow.handle(url).then(tellLinkOutcome, () => tellApp({ kind: "error", text: "This link can't start a recording." }));
  });
}

function tellLinkOutcome(outcome: LinkOutcome): void {
  tellApp({ kind: outcome.ok ? "ok" : "error", text: outcome.message });
  if (!outcome.ok) notify("TA Call Recorder", outcome.message);
  if (!outcome.ok && outcome.code === "notice") showWizard();
  if (outcome.ok && outcome.clockWarning) {
    // Shown after the start message, and as a notification: Solace may reject a call with a wrong clock.
    setTimeout(() => tellApp({ kind: "warn", text: outcome.clockWarning ?? "" }), 1500);
    notify("TA Call Recorder", outcome.clockWarning);
  }
}

function tellApp(message: AppMessage): void {
  if (recorderWin && !recorderWin.isDestroyed()) recorderWin.webContents.send(IPC.appMessage, message);
}

function callsChanged(): void {
  if (recorderWin && !recorderWin.isDestroyed()) recorderWin.webContents.send(IPC.callsChanged);
}

function showWizard(): void {
  showRecorder();
  if (recorderWin && !recorderWin.isDestroyed()) recorderWin.webContents.send(IPC.showWizard);
}

// ---------- smoke tests ----------

async function finishSmoke(): Promise<void> {
  const timeout = new Promise<boolean>((done) => setTimeout(() => done(false), 15000));
  let ok = await Promise.race([rendererReadyPromise.then(() => true), timeout]);
  console.log(ok ? "smoke: recorder window loaded, tray and shortcuts registered" : "smoke: recorder window did not report ready");
  if (ok && recorderWin) {
    // The Step 2 / Step 5 panels: the page reaches the new handlers and has the wizard and Recent calls.
    const probe = await recorderWin.webContents
      .executeJavaScript(
        `(async () => {
          const v = await window.recorderApi.getSettings();
          const calls = await window.recorderApi.listCalls();
          const t = await window.recorderApi.testSolaceAddress("http://not-https.example");
          return [typeof v.geminiModel, v.geminiKeyHint === null, Array.isArray(calls), t.level,
            !!document.getElementById("wizard"), !!document.getElementById("calls-list")].join(",");
        })()`,
      )
      .catch(() => "error");
    const probeOk = probe === "string,true,true,invalid,true,true";
    console.log(`smoke: settings, recent calls and wizard ${probeOk ? "answer" : `did not answer (${probe})`}`);
    ok = probeOk && (await smokeNetwork());
  }
  if (ok && process.argv.includes("--smoke-capture") && recorderWin && controller) {
    const client = decoder;
    const decode = client ? (webm: string, pcm: string) => decodeWebmToPcmFile(client, webm, pcm) : undefined;
    ok = await runCaptureSelfTest(recorderWin, controller, decode);
    console.log(ok ? "smoke-capture: ok" : "smoke-capture: FAILED");
  }
  if (ok && process.argv.includes("--smoke-crash") && recorderWin && controller) {
    ok = await runCrashSelfTest(recorderWin, controller);
    console.log(ok ? "smoke-crash: ok" : "smoke-crash: FAILED");
  }
  globalShortcut.unregisterAll();
  tray?.destroy();
  decoderWin?.close();
  jobs?.close();
  await log.flush();
  app.exit(ok ? 0 : 1);
}

/**
 * The app's network path (Chromium, its own session) against a throwaway server on 127.0.0.1 — no real
 * network: an answer comes back, and a redirect is refused (D-143).
 */
async function smokeNetwork(): Promise<boolean> {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "http://127.0.0.1:9/elsewhere" });
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  let answered = false;
  let redirectRefused = false;
  try {
    const r = await netFetch(`http://127.0.0.1:${port}/ok`, { method: "GET", headers: {}, redirect: "error" });
    answered = r.status === 200 && JSON.parse(await r.text()).ok === true;
    try {
      await netFetch(`http://127.0.0.1:${port}/redirect`, { method: "GET", headers: {}, redirect: "error" });
    } catch {
      redirectRefused = true;
    }
  } catch {
    answered = false;
  } finally {
    server.close();
  }
  console.log(`smoke: network (Chromium stack) answered=${answered} redirect_refused=${redirectRefused}`);
  return answered && redirectRefused;
}

// ---------- windows, tray, shortcuts ----------

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

/**
 * Start a local-only recording (tray, shortcut): refused until the D-126 notice is accepted (the set-up
 * check opens) or while a call is recorded (D-39); any armed Solace session is dropped first (M4).
 */
export function requestStart(): void {
  const c = controller;
  if (!c || !recorderWin) return;
  requestLocalStart({
    noticeAccepted: () => c.noticeAccepted(),
    isRecording: () => c.guard.isActive,
    disarm: () => c.disarm(),
    start: () => {
      if (recorderWin) sendCommandToRecorder(recorderWin, "start");
    },
    refuse: (message, openWizard) => {
      notify("TA Call Recorder", message);
      tellApp({ kind: "error", text: message });
      if (openWizard) showWizard();
    },
  });
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
  log.event("app.quit", {});
  if (controller?.guard.isActive && recorderWin) {
    // Save the call before leaving. Whatever is not finalised in time is recovered at the next start (R6).
    sendCommandToRecorder(recorderWin, "stop");
    void waitUntilIdle(15000).then(() => app.quit());
  } else {
    app.quit();
  }
}

// ---------- IPC ----------

function fromOwnPage(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return isOwnPage(event.senderFrame?.url ?? "", rendererDir);
}

async function fullView(c: RecorderController): Promise<SettingsView> {
  const s = c.appSettings;
  return {
    ...c.settingsView(),
    solaceBaseUrl: s.solaceBaseUrl,
    geminiModel: s.geminiModel ?? DEFAULT_GEMINI_MODEL,
    geminiModelIsDefault: !s.geminiModel,
    geminiKeyHint: (await secrets?.geminiKeyHint()) ?? null,
    keyStorageOk: secrets?.canPersist() ?? false,
    dev: DEV,
    noticeAccepted: !!s.noticeAcceptedAt,
    wizardDone: !!s.wizardDoneAt,
  };
}

function settingsHost(c: RecorderController, s: SecretStore): SettingsHost {
  return {
    get: () => c.appSettings,
    save: (patch) => c.updateSettings(patch),
    isRecording: () => c.guard.isActive,
    secrets: s,
    dev: DEV,
    keyChanged: () => {
      log.event("settings.key_changed", {});
      void jobs?.keyChanged().finally(() => callsChanged());
    },
  };
}

/** The queued call with this id, if its folder is the one the app made for it. */
function callFolder(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const job = jobs?.get(id);
  if (!job || basename(job.folder) !== id || !existsSync(job.folder)) return null;
  return job.folder;
}

function registerIpc(c: RecorderController): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromOwnPage(event)) throw new Error("Refused");
      return fn(...args);
    });
  const host = () => (secrets ? settingsHost(c, secrets) : null);
  const text = (v: unknown) => (typeof v === "string" ? v : "");

  handle(IPC.beginCall, (mic, intent) => {
    const m = (mic ?? {}) as Record<string, unknown>;
    const micProcessing = { echoCancellation: m.echoCancellation === true, noiseSuppression: m.noiseSuppression === true, autoGainControl: m.autoGainControl === true };
    return c.beginCall(micProcessing, intent === "linked" ? "linked" : "local");
  });
  handle(IPC.appendChunk, (callId, track, data) => c.appendChunk(callId, track, data));
  handle(IPC.markPause, (callId, kind, recordedMs) => c.markPause(callId, kind, recordedMs));
  handle(IPC.endCall, (callId, recordedMs) => c.endCall(callId, recordedMs));
  handle(IPC.abortCall, (callId) => c.abortCall(callId));
  handle(IPC.getSettings, () => fullView(c));
  handle(IPC.setMicProcessing, async (on) => {
    await c.setMicProcessing(on === true);
    return fullView(c);
  });
  handle(IPC.chooseDir, async () => {
    if (!recorderWin) return fullView(c);
    const picked = await dialog.showOpenDialog(recorderWin, { title: "Choose the recordings folder", properties: ["openDirectory", "createDirectory"], defaultPath: c.recordingsDir() });
    const problem = picked.canceled || !picked.filePaths[0] ? null : await c.setRecordingsDir(picked.filePaths[0]);
    const view = await fullView(c);
    if (problem) view.notices.unshift(problem);
    return view;
  });
  handle(IPC.openFolder, async () => {
    if (c.dirProblem()) return;
    await mkdir(c.recordingsDir(), { recursive: true });
    await shell.openPath(c.recordingsDir());
  });

  // Settings: Solace address, Gemini key and model.
  handle(IPC.setSolaceAddress, async (raw) => {
    const h = host();
    const problem = h ? await setSolaceAddress(h, text(raw)) : "Not ready yet.";
    if (!problem) log.event("settings.solace_address_set", {});
    return { problem, view: await fullView(c) };
  });
  handle(IPC.testSolaceAddress, async (raw) => {
    const r = await testSolaceAddress(netFetch, text(raw), { dev: DEV });
    log.event("wizard.solace_test", { level: r.level });
    return { ok: r.ok, level: r.level, message: r.message };
  });
  handle(IPC.setGeminiKey, async (raw) => {
    const h = host();
    const problem = h ? await setGeminiKey(h, text(raw)) : "Not ready yet.";
    return { problem, view: await fullView(c) };
  });
  handle(IPC.clearGeminiKey, async () => {
    const h = host();
    if (h) await clearGeminiKey(h);
    return fullView(c);
  });
  handle(IPC.setGeminiModel, async (raw) => {
    const h = host();
    const problem = h ? await setGeminiModel(h, text(raw)) : "Not ready yet.";
    return { problem, view: await fullView(c) };
  });

  // Recent calls.
  handle(IPC.listCalls, async () => {
    const list = jobs?.list() ?? [];
    const transcriptIds = new Set(list.filter((j) => existsSync(join(j.folder, `${j.id}.transcript.md`))).map((j) => j.id));
    return callRows(list, { hasKey: !!(await secrets?.getGeminiKey()), transcriptIds });
  });
  handle(IPC.retryCall, async (id) => {
    if (typeof id === "string") await jobs?.retry(id);
  });
  handle(IPC.openCallFolder, async (id) => {
    const folder = callFolder(id);
    if (folder) await shell.openPath(folder);
  });
  handle(IPC.openTranscript, async (id) => {
    const folder = callFolder(id);
    const file = folder ? join(folder, `${id as string}.transcript.md`) : null;
    if (!file || !existsSync(file)) return false;
    return (await shell.openPath(file)) === "";
  });

  // First-run wizard (D-132).
  handle(IPC.acceptNotice, async () => {
    await c.updateSettings({ noticeAcceptedAt: new Date().toISOString() });
    log.event("wizard.notice_accepted", {});
    return fullView(c);
  });
  handle(IPC.finishWizard, async () => {
    await c.updateSettings({ wizardDoneAt: new Date().toISOString() });
    log.event("wizard.done", {});
    return fullView(c);
  });
  handle(IPC.openMicSettings, async () => {
    await shell.openExternal(WINDOWS_MIC_SETTINGS);
  });
  handle(IPC.testDial, async (raw) => {
    const link = telLink(raw);
    if (!link) return false;
    await shell.openExternal(link);
    log.event("wizard.test_dial", {});
    return true;
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
