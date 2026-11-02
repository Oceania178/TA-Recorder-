// UX screenshots of every screen and state of the desktop app (development build only, fake data only).
// Usage: node scripts/ux/screens.mjs <output folder>
//
// - The app runs from this checkout with a throwaway profile in %TEMP% (--user-data-dir) and the existing
//   development-only hooks (--dev --e2e --e2e-audio): scripted audio, never the real mic or system audio.
// - A fake Solace and a fake Gemini on 127.0.0.1 (ports 4290 / 4291) answer as told (ok, hang, refuse, busy).
//   Nothing leaves this laptop. No protocol registration, no Task Scheduler, no Windows setting is touched.
// - Screenshots are taken in the main process with webContents.capturePage, through the Node inspector of the
//   development build (--inspect, 127.0.0.1 only). The renderer is driven through the debugging port, with the
//   page's own buttons. shell.openExternal is stubbed in the main process, so "Test dial" and "Open Windows
//   microphone settings" open nothing. The wizard's mic / sound checks get fake streams (an oscillator).
// - UX round 2: Windows notifications are not shown; their title and text are logged (Notification.prototype.show
//   is replaced in the main process). The tray menu is native and is covered by unit tests, not screenshots.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectPage } from "../e2e/cdp.mjs";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = resolve(process.argv[2] ?? join(dirname(APP_DIR), "logs", "ux-app", "shots"));
const ELECTRON = join(APP_DIR, "node_modules", "electron", "dist", "electron.exe");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const WORK = join(tmpdir(), `tacr-ux-${STAMP}`);
const PORT = { solace: 4290, gemini: 4291, cdp: 9349, inspect: 9350 };
const FAKE_KEY = "ux-fake-gemini-key-1234";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });
const LOG = join(OUT, "screens.log");
const say = (m) => {
  const line = `${new Date().toISOString()} ${m}`;
  console.log(line);
  appendFileSync(LOG, `${line}\n`);
};

// ---------- fake servers ----------
const readBody = (req) => new Promise((done) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => done(Buffer.concat(parts)));
});
const listen = (server, port) => new Promise((done, fail) => {
  server.once("error", fail);
  server.listen(port, "127.0.0.1", () => done(server));
});
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/** mode: ok | hang | reject (403, the key) */
const gemini = { mode: "ok", held: [] };
async function startFakeGemini() {
  const server = createServer(async (req, res) => {
    await readBody(req);
    const answer = () => json(res, 200, { candidates: [{ content: { role: "model", parts: [{ text: "Dạ em chào anh ạ." }] }, finishReason: "STOP" }] });
    if (gemini.mode === "hang") return gemini.held.push(answer);
    if (gemini.mode === "reject") return json(res, 403, { error: { code: 403, message: "API key not valid", status: "PERMISSION_DENIED" } });
    answer();
  });
  return listen(server, PORT.gemini);
}
function releaseGemini() {
  const held = gemini.held.splice(0);
  held.forEach((f) => f());
}

/** Uploads: ok | hang | busy (503) */
const solace = { upload: "ok", held: [] };
async function startFakeSolace() {
  const server = createServer(async (req, res) => {
    await readBody(req);
    if (req.method === "GET" && req.url === "/api/health") return json(res, 200, { ok: true, service: "vngg-ats" });
    if (req.method === "POST" && req.url === "/api/call-recorder/tickets/check") {
      // The fake link ticket says what to answer: <kind>_<session id>_<3cx|self>_<padding>.
      const ticket = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      const [kind, session, mode] = ticket.split("_");
      say(`fake Solace: ticket check (${kind}, ${session})`);
      if (kind === "refuse") return json(res, 401, { error: "invalid_ticket" });
      const offset = kind === "clock" ? 12 * 60_000 : 0;
      return json(res, 200, {
        ok: true, session_id: session, dial_mode: mode === "self" ? "self_dial" : "3cx",
        upload_until: new Date(Date.now() + 72 * 3600_000).toISOString(), upload_ticket: `upload-${session}-${"u".repeat(40)}`,
        server_time: new Date(Date.now() + offset).toISOString(),
      });
    }
    if (req.method === "POST" && req.url === "/api/call-recorder/transcripts") {
      const answer = () => json(res, 201, { call_id: `call-${Math.random().toString(16).slice(2, 10)}` });
      if (solace.upload === "hang") return solace.held.push(answer);
      if (solace.upload === "busy") return json(res, 503, { error: "busy" });
      return answer();
    }
    json(res, 404, { error: "not_found" });
  });
  return listen(server, PORT.solace);
}
function releaseSolace() {
  solace.held.splice(0).forEach((f) => f());
}
const link = (kind, session, mode = "3cx") => {
  const ticket = `${kind}_${session}_${mode === "self_dial" ? "self" : "3cx"}_${"x".repeat(32)}`;
  return `tacallrecorder://start?session_id=${session}&ticket=${ticket}&dial_mode=${mode}`;
};

// ---------- the app ----------
let child = null;
let page = null;
let main = null;
let profile = null;

async function connectNode(port, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  let target = null;
  while (!target && Date.now() < until) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list[0] ?? null;
    } catch { /* not up yet */ }
    if (!target) await sleep(300);
  }
  if (!target) throw new Error("no main-process inspector");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    ws.addEventListener("open", done, { once: true });
    ws.addEventListener("error", () => fail(new Error("inspector connection failed")), { once: true });
  });
  let next = 1;
  const waiting = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  });
  const send = (method, params = {}) => new Promise((done) => {
    const id = next++;
    waiting.set(id, done);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send("Runtime.enable");
  return {
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
      if (r.error) throw new Error(r.error.message);
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "main exception");
      return r.result?.result?.value;
    },
    close() {
      try { ws.close(); } catch { /* closed */ }
    },
  };
}

function writeSettings(dir, s) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    recordingsDir: null, micProcessing: false, solaceBaseUrl: null, geminiModel: null, noticeAcceptedAt: null,
    wizardDoneAt: null, cleanupTaskFor: null, knownRecordingsDirs: [], testMode: false, ...s,
  }, null, 2));
}

async function startApp(name, extraEnv = {}, extraArgs = []) {
  profile = join(WORK, name);
  const args = [`--inspect=127.0.0.1:${PORT.inspect}`, APP_DIR, `--user-data-dir=${profile}`, "--dev", "--e2e", "--e2e-audio",
    `--e2e-gemini-endpoint=http://127.0.0.1:${PORT.gemini}`, `--remote-debugging-port=${PORT.cdp}`, ...extraArgs];
  child = spawn(ELECTRON, args, { cwd: APP_DIR, env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
  child.stdout.on("data", () => undefined);
  child.stderr.on("data", () => undefined);
  main = await connectNode(PORT.inspect, 60_000);
  page = await connectPage(PORT.cdp, "recorder.html", 60_000);
  await waitFor("page ready", () => page.eval(`!!document.body.dataset.state && document.getElementById("status").textContent === "Ready"`), 30_000);
  // Nothing opens outside the app: Test dial and the Windows settings button become no-ops.
  await main.eval(`(() => { const e = require("electron"); e.shell.openExternal = async () => undefined; e.shell.openPath = async () => ""; return true; })()`);
  await main.eval(`(() => { const N = require("electron").Notification; globalThis.__uxNotes = []; N.prototype.show = function () { globalThis.__uxNotes.push({ title: this.title, body: this.body }); }; return true; })()`);
  await sleep(800);
}
async function stopApp() {
  page?.close();
  main?.close();
  page = null;
  main = null;
  if (child && child.exitCode === null) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 20_000 });
  child = null;
  await sleep(1500);
}
async function sendLink(url) {
  const c = spawn(ELECTRON, [APP_DIR, `--user-data-dir=${profile}`, url], { cwd: APP_DIR, windowsHide: true, stdio: "ignore" });
  await waitFor("second instance exit", async () => c.exitCode !== null, 30_000);
  await sleep(1200);
}
async function waitFor(label, fn, timeoutMs, every = 300) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (await fn()) return true;
    } catch { /* retry */ }
    await sleep(every);
  }
  throw new Error(`timed out: ${label}`);
}

/** Main process: capture the recorder window (full = grown to its content height) or the bar. */
async function shot(name, { which = "recorder", full = true } = {}) {
  const file = join(OUT, `${name}.png`);
  const r = await main.eval(`(async () => {
    const { BrowserWindow } = require("electron");
    const fs = require("fs");
    const part = ${JSON.stringify(which === "bar" ? "bar.html" : "recorder.html")};
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(part));
    if (!w) return "no window";
    const before = w.getContentSize();
    if (${full && which !== "bar"}) {
      const h = await w.webContents.executeJavaScript("Math.max(document.documentElement.scrollHeight, (document.getElementById('wizard')?.hidden ? 0 : document.querySelector('.wizard').scrollHeight + 32))");
      w.setContentSize(before[0], Math.min(4000, Math.max(before[1], Math.ceil(h))));
      await new Promise((r) => setTimeout(r, 450));
    }
    const img = await w.webContents.capturePage();
    fs.writeFileSync(${JSON.stringify(file)}, img.toPNG());
    if (${full && which !== "bar"}) w.setContentSize(before[0], before[1]);
    return "ok";
  })()`);
  say(`shot ${name}: ${r}`);
}

/** The recorder window: visible or not (P2), and bring it back as the bar's open button does. */
const windowVisible = () => main.eval(`require("electron").BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("recorder.html"))?.isVisible() ?? null`);
const barVisible = () => main.eval(`require("electron").BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("bar.html"))?.isVisible() ?? null`);
async function showWindow() {
  await main.eval(`(() => { const w = require("electron").BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("recorder.html")); w.show(); return true; })()`);
  await sleep(500);
}
const click = (id) => page.eval(`document.getElementById(${JSON.stringify(id)}).click(), true`);
const setValue = (id, v) => page.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event("input")); return true; })()`);
const text = (id) => page.eval(`document.getElementById(${JSON.stringify(id)}).textContent`);
const state = () => page.eval(`document.body.dataset.state`);
const cmd = (c) => page.eval(`window.__taRecorderCommand(${JSON.stringify(c)}), true`);
const scrollTop = () => page.eval(`window.scrollTo(0, 0), true`);

/** Fake devices for the wizard's mic and sound checks: an oscillator stream (loud) or a silent one. */
async function fakeDevices({ mic, system, micBlocked = false }) {
  await page.eval(`(() => {
    const make = (on, hz) => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = hz;
      gain.gain.value = on ? 0.6 : 0;
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain).connect(dest);
      osc.start();
      return dest.stream;
    };
    navigator.mediaDevices.getUserMedia = async () => {
      if (${micBlocked}) throw new DOMException("blocked", "NotAllowedError");
      return make(${mic}, 330);
    };
    navigator.mediaDevices.getDisplayMedia = async () => make(${system}, 660);
    return true;
  })()`);
}

async function recordFor(ms) {
  await waitFor("recording", async () => (await state()) === "recording", 30_000, 200);
  await sleep(ms);
  await cmd("stop");
  await waitFor("idle", async () => (await state()) === "idle", 30_000, 200);
}
const queue = async () => page.eval(`window.recorderApi.listCalls()`);
const waitStage = (pred, label, ms = 60_000) => waitFor(label, async () => (await queue()).some(pred), ms, 500);

// ---------- scenes ----------
async function firstRun() {
  const dir = join(WORK, "first-run");
  const rec = join(WORK, "rec-first");
  writeSettings(dir, { recordingsDir: rec, knownRecordingsDirs: [rec] });
  await startApp("first-run");
  await waitFor("wizard open", () => page.eval(`!document.getElementById("wizard").hidden`), 20_000);
  await shot("wizard-1-not-yet");
  // No notice yet: a start is refused (the set-up check opens again).
  await click("wizard-close");
  await cmd("start");
  await sleep(500);
  await click("wizard-close");
  await scrollTop();
  await shot("refusal-no-notice", { full: false });
  await click("btn-wizard");
  await sleep(300);
  await click("wz-accept");
  await sleep(500);
  await shot("wizard-1-pass");
  await click("wz-next");
  // Step 2: blocked, then allowed.
  await fakeDevices({ mic: true, system: true, micBlocked: true });
  await sleep(200);
  await shot("wizard-2-start");
  await click("wz-mic-test");
  await sleep(600);
  await shot("wizard-2-not-yet");
  await fakeDevices({ mic: true, system: true });
  await click("wz-mic-test");
  await sleep(600);
  await shot("wizard-2-pass");
  await click("wz-next");
  // Step 3: silent devices (not yet, then the fix hint after 15 s), then both moving.
  await fakeDevices({ mic: false, system: false });
  await sleep(200);
  await shot("wizard-3-start");
  await click("wz-sound-start");
  await sleep(1500);
  await shot("wizard-3-not-yet");
  await sleep(15_000);
  await shot("wizard-3-not-yet-hint");
  await click("wz-sound-stop");
  await sleep(500);
  await fakeDevices({ mic: true, system: true });
  await click("wz-sound-start");
  await sleep(2000);
  await shot("wizard-3-pass");
  await click("wz-sound-stop");
  await sleep(300);
  await click("wz-next");
  // Step 4: a wrong address, then the fake Solace.
  await sleep(300);
  await shot("wizard-4-start");
  await setValue("wz-solace-url", "http://solace.example.vn");
  await click("wz-solace-test");
  await sleep(1000);
  await shot("wizard-4-not-yet");
  await setValue("wz-solace-url", `http://127.0.0.1:${PORT.solace}`);
  await click("wz-solace-test");
  await sleep(1500);
  await shot("wizard-4-pass");
  await click("wz-next");
  // Step 5: no number, a number (Test dial opens nothing here), then "Yes".
  await sleep(300);
  await shot("wizard-5-start");
  await click("wz-dial");
  await sleep(500);
  await shot("wizard-5-not-yet");
  await setValue("wz-dial-number", "0900 000 000");
  await click("wz-dial");
  await sleep(600);
  await shot("wizard-5-asked");
  await click("wz-dial-ok");
  await sleep(300);
  await shot("wizard-5-pass");
  await click("wz-next");
  await sleep(800);

  // Main window, Test mode off, no key.
  await scrollTop();
  await shot("main-idle-first-view", { full: false });
  await shot("main-idle-full-key-not-set-test-off");
  await click("btn-start");
  await sleep(500);
  await scrollTop();
  await shot("refusal-test-mode-off", { full: false });

  // Test mode on; a call with no key → Recorded, "Add a Gemini key".
  await click("test-mode");
  await sleep(600);
  await shot("settings-test-mode-on-key-not-set");
  await scrollTop();
  const tLocal = Date.now();
  await click("btn-start");
  await waitFor("recording", async () => (await state()) === "recording", 30_000, 50);
  say(`time to start: Start pressed → recording in ${Date.now() - tLocal} ms`);
  await sleep(3000);
  await shot("main-recording-local");
  await shot("bar-recording-test-mode", { which: "bar" });
  await cmd("start"); // busy
  await sleep(400);
  await shot("refusal-busy", { full: false });
  await cmd("pause");
  await sleep(800);
  await shot("main-paused");
  await shot("bar-paused", { which: "bar" });
  await cmd("resume");
  await sleep(500);
  // 3 h 50: the page's clock jumps ahead (the recording itself is untouched), then back before Stop.
  await page.eval(`(() => { const real = performance.now.bind(performance); window.__realNow = real; performance.now = () => real() + (3 * 60 + 50) * 60000 + 5000; return true; })()`);
  await sleep(800);
  await shot("warning-3h50", { full: false });
  await shot("bar-warning", { which: "bar" });
  await page.eval(`(() => { performance.now = window.__realNow; return true; })()`);
  await sleep(500);
  await cmd("stop");
  await waitFor("idle", async () => (await state()) === "idle", 30_000, 200);
  await sleep(1500);
  await shot("main-saved", { full: false });
  await shot("calls-recorded-no-key");
  await shot("bar-follow-waiting-key", { which: "bar" });

  // Key set (fake), the waiting call is transcribed: Local only.
  gemini.mode = "ok";
  await setValue("gemini-key", FAKE_KEY);
  await click("btn-key-save");
  await waitStage((r) => r.detail?.startsWith("Local only"), "local only transcribed");
  await sleep(800);
  await shot("bar-follow-local", { which: "bar" });
  await shot("settings-key-set-test-on");
  await sleep(6500);
  say(`P3: bar after a Local only call is transcribed, 6.5 s later: visible=${await barVisible()}`);

  // Linked call: Transcribing (Gemini hangs) → Sending (Solace hangs) → Sent.
  gemini.mode = "hang";
  solace.upload = "hang";
  const tLink = Date.now();
  await sendLink(link("ok", "ux-session-sent-0001"));
  await waitFor("linked recording", async () => (await state()) === "recording", 30_000, 50);
  say(`time to start: Solace link handed to Windows → recording in ${Date.now() - tLink} ms (includes the ~1.2 s pause after the second process)`);
  await sleep(2500);
  say(`P2: recorder window visible after the Solace start: ${await windowVisible()} (expected false); bar visible: ${await barVisible()}`);
  await shot("bar-recording-linked", { which: "bar" });
  await showWindow();
  await shot("main-recording-linked");
  // Busy: a link while a call is recorded.
  await sendLink(link("ok", "ux-session-busy-0002"));
  await sleep(500);
  await shot("refusal-busy-link", { full: false });
  say(`P2: a refused link (busy) shows the window: visible=${await windowVisible()}`);
  await cmd("stop");
  await waitFor("idle", async () => (await state()) === "idle", 30_000, 200);
  await waitStage((r) => r.stage === "Transcribing", "transcribing");
  await sleep(600);
  await shot("calls-transcribing");
  await shot("bar-follow-transcribing", { which: "bar" });
  gemini.mode = "ok";
  releaseGemini();
  await waitStage((r) => r.stage === "Sending", "sending");
  await sleep(600);
  await shot("calls-sending");
  await shot("bar-follow-sending", { which: "bar" });
  solace.upload = "ok";
  releaseSolace();
  await waitStage((r) => r.stage === "Sent", "sent");
  await sleep(500);
  await shot("bar-follow-sent", { which: "bar" });
  await sleep(6500);
  say(`P3: bar 7 s after Sent: visible=${await barVisible()} (expected false)`);

  // Transcribed, waiting to send (Solace busy).
  solace.upload = "busy";
  await sendLink(link("ok", "ux-session-wait-0003", "self_dial"));
  await waitFor("self-dial recording", async () => (await state()) === "recording", 30_000, 200);
  await sleep(1500);
  await showWindow();
  await shot("main-recording-self-dial");
  await sleep(1500);
  await cmd("stop");
  await waitFor("idle", async () => (await state()) === "idle", 30_000, 200);
  await waitStage((r) => r.stage === "Transcribed" && r.detail?.startsWith("Waiting"), "transcribed waiting", 90_000);

  // Failed: Gemini refuses the key.
  gemini.mode = "reject";
  await sendLink(link("ok", "ux-session-fail-0004"));
  await recordFor(3000);
  await waitStage((r) => r.stage === "Failed", "failed", 90_000);
  await sleep(800);
  await shot("bar-follow-failed", { which: "bar" });
  await showWindow();
  await shot("calls-all-stages");

  // Refusals from links: bad link, refused ticket, clock warning.
  gemini.mode = "ok";
  await sendLink("tacallrecorder://start?session_id=bad");
  await scrollTop();
  await shot("refusal-bad-link", { full: false });
  await sendLink(link("refuse", "ux-session-refused-05"));
  await scrollTop();
  await shot("refusal-refused-ticket", { full: false });
  await sendLink(link("clock", "ux-session-clock-0006"));
  await waitFor("clock recording", async () => (await state()) === "recording", 30_000, 200);
  await sleep(2500);
  await showWindow();
  await shot("warning-clock", { full: false });
  await cmd("stop");
  await waitFor("idle", async () => (await state()) === "idle", 30_000, 200);
  await sleep(500);

  // Settings with Test mode off again (key set).
  await click("test-mode");
  await sleep(600);
  await shot("settings-key-set-test-off");
  say(`P11 notifications shown: ${JSON.stringify(await main.eval("globalThis.__uxNotes"))}`);
  await stopApp();
}

async function folderProblems() {
  const fakeOneDrive = join(WORK, "FakeOneDrive");
  mkdirSync(fakeOneDrive, { recursive: true });
  const now = new Date().toISOString();
  for (const [name, dir, env] of [
    ["refusal-onedrive-folder", join(fakeOneDrive, "Recordings"), { OneDrive: fakeOneDrive, OneDriveCommercial: fakeOneDrive }],
    ["refusal-network-folder", "Q:\\TA Call Recorder", {}],
  ]) {
    writeSettings(join(WORK, name), { recordingsDir: dir, knownRecordingsDirs: [], noticeAcceptedAt: now, wizardDoneAt: now, solaceBaseUrl: `http://127.0.0.1:${PORT.solace}`, testMode: true });
    await startApp(name, env);
    await shot(name);
    await stopApp();
  }
}

async function run() {
  for (const p of Object.values(PORT)) {
    const busy = await fetch(`http://127.0.0.1:${p}/`).then(() => true, () => false);
    if (busy) throw new Error(`port ${p} is in use`);
  }
  const b = spawnSync(process.execPath, ["build/build.mjs"], { cwd: APP_DIR, encoding: "utf8", timeout: 120_000 });
  if (b.status !== 0) throw new Error(`build failed: ${b.stderr}`);
  const servers = [await startFakeGemini(), await startFakeSolace()];
  try {
    await firstRun();
    await folderProblems();
  } finally {
    await stopApp();
    servers.forEach((s) => s.close());
    try { rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  say(`done: ${OUT}`);
}

run().catch(async (e) => {
  say(`FAILED: ${e.stack ?? e}`);
  await stopApp();
  process.exit(1);
});
