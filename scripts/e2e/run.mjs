// End-to-end run: the real Solace backend (branch feat/call-recorder-phase-0-1) and the real desktop app (this
// repo, development build) together, with a throwaway database, invented data and fake servers on 127.0.0.1.
// Nothing leaves this laptop. See scripts/e2e/README.md. Usage: node scripts/e2e/run.mjs [--keep-work]
//
// Ports: Solace 4100, logging proxy 4101 (the app's Solace address), fake Gemini 4190, fake LLM 4191,
// app debugging port 9339 (127.0.0.1 only). Everything started here is stopped at the end, also on failure.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync, cpSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { connectPage } from "./cdp.mjs";
import { startFakeGemini, startFakeLlm, startSolaceProxy, GEMINI_SCRIPT } from "./fakes.mjs";
import { utimesSync } from "node:fs";

/** D-171: a 16-bit PCM WAV of tone bursts (pitch, from s, to s) per channel — invented audio, no voice. */
function toneWav(channels, seconds, rate = 48_000) {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * channels.length * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    channels.forEach((bursts, c) => {
      let v = 0;
      for (const [hz, a, b] of bursts) if (t >= a && t < b) v += 0.5 * Math.sin(2 * Math.PI * hz * t);
      data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), (i * channels.length + c) * 2);
    });
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels.length, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels.length * 2, 28); h.writeUInt16LE(channels.length * 2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ---------- configuration ----------
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOLACE_DIR = process.env.E2E_SOLACE_DIR ?? "C:\\Users\\LAP15911\\solace-worktrees\\call-recorder";
const BACKEND = join(SOLACE_DIR, "backend");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const WORK = process.env.E2E_WORK ?? join(tmpdir(), `tacr-e2e-${STAMP}`);
const LOGS = process.env.E2E_LOGS ?? join(dirname(APP_DIR), "logs", `e2e-${STAMP}`);
const KEEP_WORK = process.argv.includes("--keep-work");
const PORT = { solace: 4100, proxy: 4101, gemini: 4190, llm: 4191, cdp: 9339 };
const SOLACE_URL = `http://127.0.0.1:${PORT.solace}`;
const FAKE_GEMINI_KEY = "e2e-fake-gemini-key-0000";
const FAKE_LLM_KEY = "fake";
const TA_EMAIL = "ta.e2e@example.test";
const ADMIN_EMAIL = "admin.e2e@example.test";
const JOB_CODE = "26-E2E-101";
const RETENTION_OFFSET_MS = 73 * 3600_000; // the sweep deletes 72 h after the call ended (D-140)
const ELECTRON = join(APP_DIR, "node_modules", "electron", "dist", "electron.exe");
const DB_FILE = join(WORK, "solace-e2e.db");
const DB_URL = `file:${DB_FILE.replace(/\\/g, "/")}`;
const FILES_DIR = join(WORK, "solace-files");
const USER_DATA = join(WORK, "app-userdata");
const RECORDINGS = join(WORK, "recordings");
/** D-171: the file "Import a recording" takes in this run (--e2e-import-file); rewritten before each import. */
const IMPORT_FILE = join(WORK, "import", "phone-recording.wav");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(LOGS, { recursive: true });
const RUN_LOG = join(LOGS, "run.log");
function say(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendFileSync(RUN_LOG, `${line}\n`);
}

// ---------- results ----------
const STEPS = {
  1: "Seed Solace", 2: "Create a session (3cx, self_dial)", 3: "Ticket check", 4: "Record", 5: "Transcribe", 6: "Send",
  7: "Solace shows it", 8: "Search and Sol", 9: "Local only (D-82)", 10: "Retention (D-140)", 11: "Time tracker",
  12: "Import recording (D-171)",
};
const checks = [];
function check(step, name, ok, evidence) {
  checks.push({ step, name, ok: !!ok, evidence });
  say(`${ok ? "PASS" : "FAIL"} [${step}] ${name} — ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`);
  return !!ok;
}

// ---------- processes and servers we start (all stopped in finally) ----------
const children = new Set();
const servers = [];
function track(child, label) {
  children.add(child);
  child.on("exit", (code) => {
    children.delete(child);
    say(`${label} exited (${code})`);
  });
  return child;
}
function kill(child) {
  if (!child || child.exitCode !== null) return;
  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 20_000 });
}
const portOpen = (port) => new Promise((done) => {
  const s = connect({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); done(true); });
  s.once("error", () => done(false));
});
async function waitFor(label, fn, timeoutMs, everyMs = 500) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---------- Solace ----------
function solaceEnv(withLlm) {
  const drop = /^(LLM_|GRAPH_|FEEDBACK_|HRIS_|ODOO_|GITHUB_|OPENAI|ANTHROPIC|GEMINI|GOOGLE|AZURE|MS_|MULTIUSER|AUTH_|ADMIN_EMAILS|SESSION_SECRET|SIGN_IN_|APP_BASE_URL|APP_WEB_URL|NODE_ENV|DATABASE_URL|ATS_|PORT$|OUTLOOK_|SMTP|MAIL)/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.test(k)));
  Object.assign(env, {
    PORT: String(PORT.solace), DATABASE_URL: DB_URL, ATS_FILES_DIR: FILES_DIR, ATS_SECRET_KEY_FILE: join(FILES_DIR, ".ats_secret_key"),
    MULTIUSER: "on", AUTH_PROVIDER: "stub", ADMIN_EMAILS: ADMIN_EMAIL, SESSION_SECRET: "e2e-throwaway-session-secret",
    OUTLOOK_PROVIDER: "mock", CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1",
  });
  if (withLlm) Object.assign(env, { LLM_BASE_URL: `http://127.0.0.1:${PORT.llm}`, LLM_API_KEY: FAKE_LLM_KEY, LLM_MODEL: "fake-model" });
  return env;
}
let solace = null;
async function startSolace(withLlm, label) {
  const out = createWriteStream(join(LOGS, `${label}.log`));
  const child = spawn(process.execPath, [join(BACKEND, "node_modules", "tsx", "dist", "cli.mjs"), "src/server.ts"], {
    cwd: BACKEND, env: solaceEnv(withLlm), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  track(child, label);
  await waitFor("Solace /api/health", async () => (await fetch(`${SOLACE_URL}/api/health`)).ok, 120_000, 1000);
  say(`${label} is up on :${PORT.solace} (LLM ${withLlm ? "fake" : "not configured"})`);
  return child;
}
async function stopSolace() {
  kill(solace);
  solace = null;
  await waitFor("port 4100 closed", async () => !(await portOpen(PORT.solace)), 20_000);
}

async function api(method, path, { cookie, body, bearer } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${SOLACE_URL}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, headers: r.headers };
}
async function login(email, name) {
  const r = await api("GET", `/api/auth/callback?email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`);
  const c = r.headers.getSetCookie().find((x) => x.startsWith("solace_session="));
  if (!c) throw new Error(`login failed for ${email} (${r.status})`);
  const cookie = c.split(";")[0];
  const me = await api("GET", "/api/auth/me", { cookie });
  return { cookie, ...me.json };
}

// ---------- the app ----------
let app = null;
let page = null;
function appArgs(extra = []) {
  return [APP_DIR, `--user-data-dir=${USER_DATA}`, "--dev", "--e2e", "--e2e-audio", `--e2e-gemini-endpoint=http://127.0.0.1:${PORT.gemini}`, `--e2e-import-file=${IMPORT_FILE}`, `--remote-debugging-port=${PORT.cdp}`, "--hidden", ...extra];
}
async function startApp(extra, label) {
  const out = createWriteStream(join(LOGS, `${label}.log`));
  const child = spawn(ELECTRON, appArgs(extra), { cwd: APP_DIR, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  track(child, label);
  app = child;
  page = await connectPage(PORT.cdp, "recorder.html", 60_000);
  await waitFor("recorder page ready", () => page.eval(`!!document.body.dataset.state`), 30_000);
  return child;
}
async function stopApp() {
  page?.close();
  page = null;
  kill(app);
  app = null;
  await waitFor("debugging port closed", async () => !(await portOpen(PORT.cdp)), 20_000);
}
/** How Windows hands a link to the running app: a second process with the link, which passes it on and exits. */
async function sendLinkToRunningApp(link) {
  const child = spawn(ELECTRON, [APP_DIR, `--user-data-dir=${USER_DATA}`, link], { cwd: APP_DIR, windowsHide: true, stdio: "ignore" });
  track(child, "app second instance");
  await waitFor("second instance to exit", async () => child.exitCode !== null, 30_000);
}
const appState = () => page.eval(`document.body.dataset.state`);
const appMessage = () => page.eval(`document.getElementById("message").textContent`);
const linkState = () => page.eval(`(() => { const e = document.getElementById("link-state"); return e.hidden ? null : e.textContent; })()`);
const queueJobs = () => {
  try {
    return JSON.parse(readFileSync(join(USER_DATA, "queue.json"), "utf8")).jobs;
  } catch {
    return [];
  }
};
const callFolders = () => (existsSync(RECORDINGS) ? readdirSync(RECORDINGS).filter((n) => !n.startsWith(".")) : []);
function ticketFileExists(sessionId) {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).some((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name === `${sessionId}.bin`));
  const dir = join(USER_DATA, "secrets");
  return existsSync(dir) && walk(dir);
}

/** Records the scripted ~20 s call: waits for "recording", lets it run, presses Stop, waits for idle. */
async function recordScriptedCall(label) {
  await waitFor(`${label}: recording`, async () => (await appState()) === "recording", 30_000, 200);
  const t0 = Date.now();
  await sleep(20_500);
  await page.eval(`window.__taRecorderCommand("stop")`);
  await waitFor(`${label}: saved`, async () => (await appState()) === "idle", 30_000, 200);
  say(`${label}: recorded ${((Date.now() - t0) / 1000).toFixed(1)} s and stopped`);
}
const waitStage = (id, stages, ms) =>
  waitFor(`job ${id} to reach ${stages.join("/")}`, () => {
    const j = queueJobs().find((x) => x.id === id);
    return j && stages.includes(j.stage) ? j : null;
  }, ms, 1000);

/** The "Paste your notes" box exactly as the form prefills it (Solace shared/callTranscript.ts formatCallsForNotes). */
function boxText(calls) {
  const pad = (n) => String(n).padStart(2, "0");
  const mmss = (ms) => {
    const t = Math.max(0, Math.floor(ms / 1000));
    return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
  };
  const ict = (iso) => {
    const d = new Date(new Date(iso).getTime() + 7 * 3600_000);
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${String(d.getUTCFullYear()).padStart(4, "0")} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };
  const dur = (sec) => {
    const x = Math.max(0, Math.round(sec));
    return `${Math.floor(x / 60)}m ${pad(x % 60)}s`;
  };
  const breaks = new RegExp("[\r\n\u0085\u2028\u2029]+", "g");
  const turn = (s) => `${s.speaker === "ta" ? "TA" : "Ứng viên"} [${mmss(s.start_ms)}] ${s.text.replace(breaks, " ")}`;
  return calls
    .filter((c) => c.segments.length > 0)
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
    .map((c, i) => [`── Call ${i + 1} · ${ict(c.started_at)} · ${dur(c.duration_s)} ──`, ...[...c.segments].sort((a, b) => a.start_ms - b.start_ms).map(turn)].join("\n"))
    .join("\n\n");
}
const vnToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());

// ---------- the run ----------
let prisma = null;
let gemini = null;
let llm = null;
let proxy = null;

async function preflight() {
  if (!existsSync(join(BACKEND, "node_modules", "tsx", "dist", "cli.mjs"))) throw new Error(`Solace backend not found at ${BACKEND}`);
  if (existsSync(join(BACKEND, ".env"))) throw new Error("backend/.env exists in the Solace worktree: refusing (it could hold real keys)");
  if (/onedrive/i.test(WORK)) throw new Error("the work folder must not be inside OneDrive");
  if (resolve(WORK).toLowerCase().startsWith(resolve(SOLACE_DIR).toLowerCase() + sep)) throw new Error("the work folder must not be inside the Solace worktree");
  for (const [name, port] of Object.entries(PORT)) if (await portOpen(port)) throw new Error(`port ${port} (${name}) is already in use`);
  mkdirSync(FILES_DIR, { recursive: true });
  mkdirSync(RECORDINGS, { recursive: true });
  say(`work folder ${WORK}; logs ${LOGS}`);
  const build = spawnSync(process.execPath, ["build/build.mjs"], { cwd: APP_DIR, encoding: "utf8", timeout: 120_000 });
  if (build.status !== 0) throw new Error(`app build failed: ${build.stderr}`);
  const push = spawnSync(process.execPath, [join(BACKEND, "node_modules", "prisma", "build", "index.js"), "db", "push", "--skip-generate", "--accept-data-loss"], {
    cwd: BACKEND, encoding: "utf8", timeout: 180_000, env: { ...solaceEnv(false) },
  });
  writeFileSync(join(LOGS, "prisma-db-push.log"), `${push.stdout}\n${push.stderr}`);
  if (push.status !== 0) throw new Error("prisma db push failed (see prisma-db-push.log)");
  const require = createRequire(join(BACKEND, "package.json"));
  const { PrismaClient } = require("@prisma/client");
  prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  // Automation's kill switch, before boot: no daily job runs (they would be no-ops on a fresh DB anyway).
  await prisma.appSetting.create({ data: { key: "automation.enabled", value: "false" } });
}

async function run() {
  await preflight();
  gemini = await startFakeGemini(PORT.gemini, FAKE_GEMINI_KEY);
  llm = await startFakeLlm(PORT.llm, FAKE_LLM_KEY);
  proxy = await startSolaceProxy(PORT.proxy, { host: "127.0.0.1", port: PORT.solace });
  servers.push(gemini.server, llm.server, proxy.server);
  solace = await startSolace(true, "solace");

  // ---- 1. Seed ----
  const ta = await login(TA_EMAIL, "Ngô Thị E2E");
  const admin = await login(ADMIN_EMAIL, "Quản Trị E2E");
  check(1, "TA signs in (stub auth, MULTIUSER=on) as a recruiter; admin as admin", ta.role === "recruiter" && admin.role === "admin", { ta: ta.role, admin: admin.role });
  await prisma.job.create({ data: { job_code: JOB_CODE, title: "Game Designer (E2E)", department: "E2E", requester: "HM E2E", status: "open", owner_id: ta.id } });
  const cand = await prisma.candidate.create({ data: { name: "Trần Thị Mai Anh", phone: "0900 000 001", owner_id: ta.id } });
  const application = await prisma.application.create({ data: { job_code: JOB_CODE, candidate_id: cand.id, current_stage: "phone_screen", owner_id: ta.id } });
  const appId = application.id;
  check(1, "job, candidate and application at Phone Screen seeded, owned by the TA", application.current_stage === "phone_screen", { application: appId, job: JOB_CODE });

  // ---- 2. Session A (3cx) ----
  const sA = await api("POST", "/api/call-recorder/sessions", { cookie: ta.cookie, body: { application_id: appId, dial_mode: "3cx" } });
  const A = sA.json?.session_id;
  check(2, "POST /sessions (3cx) as the TA → 201 with a deep link", sA.status === 201 && /^tacallrecorder:\/\/start\?session_id=[^&]+&ticket=[^&]+&dial_mode=3cx$/.test(sA.json?.deep_link ?? ""), { status: sA.status, session: A });

  // ---- 3. Ticket check: the app starts with the link ----
  writeFileSync(join(WORK, "notes.txt"), [
    "E2E test values (throwaway):",
    `TA login: GET /api/auth/callback?email=${TA_EMAIL} (stub auth, MULTIUSER=on); admin: ${ADMIN_EMAIL}`,
    `SESSION_SECRET=e2e-throwaway-session-secret; fake Gemini key ${FAKE_GEMINI_KEY}; LLM_API_KEY=${FAKE_LLM_KEY}`,
  ].join("\n"));
  mkdirSync(USER_DATA, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(USER_DATA, "settings.json"), JSON.stringify({
    recordingsDir: RECORDINGS, micProcessing: false, solaceBaseUrl: `http://127.0.0.1:${PORT.proxy}`, geminiModel: null,
    noticeAcceptedAt: now, wizardDoneAt: now, cleanupTaskFor: null, knownRecordingsDirs: [RECORDINGS],
  }, null, 2));
  proxy.dropResponseOnce(A); // the first answer to A's upload is lost on the way back: the app must resend (D-85)
  await startApp([sA.json.deep_link], "app-run1");
  const keySaved = await page.eval(`window.recorderApi.setGeminiKey(${JSON.stringify(FAKE_GEMINI_KEY)}).then((r) => r.problem === null && r.view.geminiKeyHint)`);
  check(3, "Gemini key saved through the Settings API (safeStorage), shown only as last 4", typeof keySaved === "string" && keySaved.endsWith("0000") && !keySaved.includes("fake"), { hint: keySaved });
  await waitFor("A recording", async () => (await appState()) === "recording", 30_000, 200);
  const sessA = await prisma.callSession.findUnique({ where: { id: A } });
  const checkReq = proxy.log.filter((e) => e.path === "/api/call-recorder/tickets/check");
  check(3, "Solace marks session A checked (checked_at set, upload ticket minted)", !!sessA?.checked_at && !!sessA?.upload_ticket_hash, { checked_at: sessA?.checked_at });
  check(3, "the app checked the ticket once, got an upload ticket and holds it (secrets/…/<session>.bin)", checkReq.length === 1 && checkReq[0].status === 200 && checkReq[0].answer_keys.includes("upload_ticket") && ticketFileExists(A), { checks: checkReq.length, status: checkReq[0]?.status, held: ticketFileExists(A) });
  check(3, "window says Linked to Solace", (await linkState()) === "Linked to Solace", await linkState());

  // ---- 4. Record ----
  await recordScriptedCall("call A");
  const folderA = join(RECORDINGS, A);
  const filesA = existsSync(folderA) ? readdirSync(folderA) : [];
  const want = [`${A}.webm`, `${A}.left.webm`, `${A}.right.webm`, `${A}.call.json`, "ta-call-recorder.call.json"];
  check(4, "call folder has the 3 audio files, the marker and call.json", want.every((f) => filesA.includes(f)), filesA);
  const metaA = JSON.parse(readFileSync(join(folderA, `${A}.call.json`), "utf8"));
  const sizes = Object.fromEntries(want.slice(0, 3).map((f) => [f.replace(A, "<id>"), statSync(join(folderA, f)).size]));
  check(4, "call.json: complete, ~20 s recorded, linked to session A (no ticket inside)", metaA.status === "complete" && metaA.session?.session_id === A && !JSON.stringify(metaA).includes(sA.json.ticket), { status: metaA.status, recorded_ms: metaA.recorded_ms ?? metaA.recordedMs, sizes });

  // ---- 5. Transcribe + 6. Send ----
  const jobA = await waitStage(A, ["sent", "failed"], 300_000);
  const tj = JSON.parse(readFileSync(join(folderA, `${A}.transcript.json`), "utf8"));
  const turns = tj.transcript.segments;
  const ordered = turns.every((t, i) => i === 0 || turns[i - 1].start_ms <= t.start_ms);
  const speakers = turns.map((t) => t.speaker).join(",");
  check(5, ".transcript.md and .transcript.json written beside the audio", existsSync(join(folderA, `${A}.transcript.md`)) && turns.length > 0, { turns: turns.length });
  check(5, "6 turns, alternating ta/candidate, in time order", ordered && speakers === "ta,candidate,ta,candidate,ta,candidate", { speakers, starts: turns.map((t) => t.start_ms) });
  const expectedTexts = [GEMINI_SCRIPT[330].text, GEMINI_SCRIPT[660].text, GEMINI_SCRIPT[440].text, GEMINI_SCRIPT[770].text, "[không nghe rõ]", GEMINI_SCRIPT[880].text];
  check(5, "scripted Vietnamese text per segment; the 400 segment became \"[không nghe rõ]\"", JSON.stringify(turns.map((t) => t.text)) === JSON.stringify(expectedTexts), turns.map((t) => t.text));
  const g440 = gemini.log.filter((e) => e.pitch === 440).map((e) => e.status);
  const g550 = gemini.log.filter((e) => e.pitch === 550).map((e) => e.status);
  check(5, "fake Gemini: one segment 429 then 200 (retried), one 400; key only in the header", g440.slice(0, 2).join(",") === "429,200" && g550[0] === 400 && gemini.log.every((e) => e.key_header_ok && !e.key_in_url && e.mime === "audio/wav"), { pitch440: g440, pitch550: g550, requests: gemini.log.length });
  check(5, "payload has_content true (the candidate spoke)", tj.call.has_content === true, tj.call);

  const upA = proxy.log.filter((e) => e.path === "/api/call-recorder/transcripts" && e.session_id === A);
  const rec = await prisma.callRecord.findUnique({ where: { session_id: A } });
  check(6, "job A sent; Solace stores a CallRecord for the right application with has_content true", jobA.stage === "sent" && rec?.application_id === appId && rec?.has_content === true && rec?.kind === "call", { stage: jobA.stage, call_id: jobA.callId, application: rec?.application_id, has_content: rec?.has_content });
  check(6, "resend after a lost answer: same bytes, 201 then 200 duplicate, same call_id (D-85)",
    upA.length === 2 && upA[0].status === 201 && upA[0].dropped_before_app_saw_it && upA[1].status === 200 && upA[1].duplicate && upA[0].sha256 === upA[1].sha256 && upA[0].call_id === upA[1].call_id && upA[1].call_id === jobA.callId,
    upA.map((e) => ({ status: e.status, dup: !!e.duplicate, dropped: !!e.dropped_before_app_saw_it, sha: e.sha256, call_id: e.call_id })));
  check(6, "the upload body is exactly the §8.24 keys, JSON only", upA.every((e) => e.json && e.content_type === "application/json" && e.keys.join(",") === "schema_version,session_id,call,transcript,recorder"), upA[0]?.keys);
  const changed = structuredClone(tj);
  changed.transcript.segments[0].text = "Một câu khác hẳn.";
  const diff = await api("POST", "/api/call-recorder/transcripts", { bearer: proxy.uploadTicketFor(A), body: changed });
  check(6, "a different payload on the same session is refused (409)", diff.status === 409 && diff.json?.error === "different_content_for_session", { status: diff.status, error: diff.json?.error });

  // ---- 2/3/4/6 again for self_dial (link delivered to the running app) ----
  const sB = await api("POST", "/api/call-recorder/sessions", { cookie: ta.cookie, body: { application_id: appId, dial_mode: "self_dial" } });
  const B = sB.json?.session_id;
  check(2, "POST /sessions (self_dial) → 201 with a self_dial deep link", sB.status === 201 && /&dial_mode=self_dial$/.test(sB.json?.deep_link ?? ""), { status: sB.status, session: B });
  await sendLinkToRunningApp(sB.json.deep_link);
  await waitFor("B recording", async () => (await appState()) === "recording", 30_000, 200);
  const msgB = await appMessage();
  check(3, "self_dial: checked, recording, the window says to dial yourself", !!(await prisma.callSession.findUnique({ where: { id: B } }))?.checked_at && /Dial the candidate yourself/.test(msgB), msgB);
  await recordScriptedCall("call B");
  const jobB = await waitStage(B, ["sent", "failed"], 300_000);
  const recB = await prisma.callRecord.findUnique({ where: { session_id: B } });
  check(6, "call B sent; CallRecord dial_mode self_dial, has_content true", jobB.stage === "sent" && recB?.dial_mode === "self_dial" && recB?.has_content === true, { stage: jobB.stage, call_id: jobB.callId });

  // ---- 6. Refusals: reused link, expired link — nothing recorded ----
  const foldersBefore = callFolders().length;
  const proxyBefore = proxy.log.length;
  await page.eval(`(document.getElementById("message").textContent = "", true)`);
  await sendLinkToRunningApp(sA.json.deep_link);
  const reuseMsg = await waitFor("refusal of the reused link", async () => { const m = await appMessage(); return m ? m : null; }, 15_000);
  check(6, "reused link A: the app refuses (already recorded), records nothing, asks Solace nothing", /already been recorded/.test(reuseMsg) && (await appState()) === "idle" && callFolders().length === foldersBefore && proxy.log.length === proxyBefore, reuseMsg);
  const reuseHttp = await api("POST", "/api/call-recorder/tickets/check", { bearer: sA.json.ticket });
  check(6, "reused link A at Solace: POST /tickets/check → 401 invalid_or_expired_ticket", reuseHttp.status === 401 && reuseHttp.json?.error === "invalid_or_expired_ticket", { status: reuseHttp.status });
  const sC = await api("POST", "/api/call-recorder/sessions", { cookie: ta.cookie, body: { application_id: appId, dial_mode: "3cx" } });
  const C = sC.json?.session_id;
  await prisma.callSession.update({ where: { id: C }, data: { expires_at: new Date(Date.now() - 60_000) } });
  await page.eval(`(document.getElementById("message").textContent = "", true)`);
  await sendLinkToRunningApp(sC.json.deep_link);
  const expMsg = await waitFor("refusal of the expired link", async () => { const m = await appMessage(); return m ? m : null; }, 15_000);
  const expCheck = proxy.log.filter((e) => e.path === "/api/call-recorder/tickets/check").at(-1);
  check(6, "expired link C: Solace answers 401, the app says so and records nothing", expCheck?.status === 401 && /did not accept this link/.test(expMsg) && (await appState()) === "idle" && !existsSync(join(RECORDINGS, C)) && !queueJobs().some((j) => j.id === C), { solace: expCheck?.status, message: expMsg });

  // ---- 7. Solace shows it ----
  const list = await api("GET", `/api/call-recorder/applications/${appId}/calls`, { cookie: ta.cookie });
  const ids = (list.json?.calls ?? []).map((c) => c.id);
  check(7, "GET calls for the application lists both calls with has_content", list.status === 200 && ids.includes(jobA.callId) && ids.includes(jobB.callId) && list.json.calls.every((c) => c.has_content === true), { status: list.status, calls: ids.length });
  const prefill = await api("GET", `/api/call-recorder/applications/${appId}/prefill`, { cookie: ta.cookie });
  const box = boxText(prefill.json?.calls ?? []);
  check(7, "\"Paste your notes\" prefill carries the transcript", prefill.status === 200 && prefill.json.at_phone_screen === true && (prefill.json.calls ?? []).length === 2 && box.includes("35 triệu") && box.includes("[không nghe rõ]"), { status: prefill.status, calls: prefill.json?.calls?.length, chars: box.length });
  const draft = await api("POST", `/api/scheduling/applications/${appId}/phone-screen/summarize`, { cookie: ta.cookie, body: { transcript: box } });
  const hm = ["functional_experience", "behaviour_skills", "motivation", "strengths", "concerns", "fit_summary"].map((k) => draft.json?.[k] ?? "").join(" | ");
  const af = llm.log.filter((e) => e.kind === "autofill").at(-1);
  check(7, "Auto-fill (fake LLM) returns a draft: no salary in the HM boxes, salary in its own field", draft.status === 200 && !/triệu|lương|salary|\d{2,}/i.test(hm) && /35/.test(draft.json?.salary?.expected ?? "") && draft.json?.salary?.source_sentence === GEMINI_SCRIPT[770].text, { status: draft.status, salary: draft.json?.salary });
  check(7, "Solace sent the transcript and the salary rule to the LLM (JSON mode)", af?.transcript_in_prompt && af?.salary_rule_in_prompt && af?.json_mode, af);

  // ---- 8. Search and Sol ----
  const plain = await api("POST", "/api/call-recorder/search", { cookie: ta.cookie, body: { q: "luong mong muon" } });
  const exact = await api("POST", "/api/call-recorder/search", { cookie: ta.cookie, body: { q: "lương", exact: true } });
  const exactMiss = await api("POST", "/api/call-recorder/search", { cookie: ta.cookie, body: { q: "luong", exact: true } });
  const hit = (r) => (r.json?.results ?? []).some((x) => x.record_id === jobA.callId);
  check(8, "search plain (\"luong mong muon\", no accents) finds call A", plain.status === 200 && hit(plain), { status: plain.status, results: plain.json?.results?.length });
  check(8, "search exact (\"lương\") finds call A; exact \"luong\" does not", exact.status === 200 && hit(exact) && !hit(exactMiss), { exact: exact.json?.results?.length, exact_without_accents: exactMiss.json?.results?.length });
  const sol = await api("POST", "/api/call-recorder/assistant/chat", { cookie: ta.cookie, body: { message: "Ứng viên nào mong muốn mức lương 35 triệu?" } });
  const cites = sol.json?.citations ?? [];
  check(8, "Ask Sol (fake LLM) answers with a valid citation to call A (the call that said 35 triệu)", sol.status === 200 && cites.length >= 1 && cites.some((c) => c.record_id === jobA.callId) && cites.every((c) => [jobA.callId, jobB.callId].includes(c.record_id) && c.application_id === appId) && !/\[R\d+\]/.test(sol.json.reply), { status: sol.status, reply: sol.json?.reply, citations: cites.map((c) => c.record_id) });

  // ---- 9. Local only (D-82) ----
  const proxyBeforeLocal = proxy.log.length;
  const geminiBeforeLocal = gemini.log.length;
  const recordsBefore = await prisma.callRecord.count();
  // D-165: with Test mode off (the default) a start without a Solace session is refused and records nothing.
  const foldersBeforeLocal = callFolders().length;
  await page.eval(`window.__taRecorderCommand("start")`);
  await sleep(2000);
  const refusedMsg = await page.eval(`document.getElementById("message").textContent`);
  check(9, "with Test mode off, a start without a link is refused (D-165) and records nothing", /Test mode in Settings/.test(refusedMsg ?? "") && (await appState()) === "idle" && callFolders().length === foldersBeforeLocal, refusedMsg);
  // Switched on the way a TA does it: the Test mode switch in the window's Settings.
  await page.eval(`document.getElementById("test-mode").click()`);
  const testModeOn = await waitFor("Test mode on", async () => (await page.eval(`document.getElementById("test-mode").checked && !document.getElementById("test-mode-badge").hidden`)) === true, 10_000, 200);
  check(9, "Test mode switched on in Settings; the window shows TEST MODE", testModeOn === true, testModeOn);
  await page.eval(`window.__taRecorderCommand("start")`);
  await waitFor("local recording", async () => (await appState()) === "recording", 30_000, 200);
  check(9, "a start without a link records Local only", /Local only/.test((await linkState()) ?? ""), await linkState());
  await recordScriptedCall("local call");
  const localJob = await waitFor("local job", () => queueJobs().find((j) => j.sessionId === null && ["local_only", "failed"].includes(j.stage)), 300_000, 1000);
  const localJson = JSON.parse(readFileSync(join(RECORDINGS, localJob.id, `${localJob.id}.transcript.json`), "utf8"));
  check(9, "transcribed on the laptop (fake Gemini), session_id null, stage local_only", localJob.stage === "local_only" && localJson.session_id === null && localJson.transcript.segments.length === 6 && gemini.log.length > geminiBeforeLocal, { stage: localJob.stage, turns: localJson.transcript.segments.length });
  await sleep(3000);
  check(9, "never sent: the Solace proxy saw nothing, no new CallRecord", proxy.log.length === proxyBeforeLocal && (await prisma.callRecord.count()) === recordsBefore, { proxy_requests_since_start: proxy.log.length - proxyBeforeLocal });

  // ---- 11. Confirm with the call → time tracker ----
  const base = await api("POST", "/api/call-recorder/time-baselines", { cookie: admin.cookie, body: { call_minutes: 20, after_call_minutes: 15, effective_from: "2026-01-01" } });
  const confirm = await api("POST", `/api/pipeline/jobs/${JOB_CODE}/transitions`, {
    cookie: ta.cookie,
    body: {
      application_id: appId, to_stage: "cv_ready_to_send", feedback_outcome: "pass",
      feedback_fields: { functional_comment: draft.json.functional_experience, soft_comment: draft.json.behaviour_skills, motivation: draft.json.motivation, strengths: draft.json.strengths, weaknesses: draft.json.concerns },
      salary: { expected_salary: 35_000_000, source: { expected_salary: "ai_suggestion" }, source_sentence: { expected_salary: draft.json.salary.source_sentence } },
      notes_snapshot: { text: box, call_ids: [jobA.callId, jobB.callId] },
    },
  });
  check(11, "Confirm (move out of Phone Screen with the note, salary and snapshot) → 201", base.status === 201 && confirm.status === 201, { baseline: base.status, confirm: confirm.status, error: confirm.json?.error });
  const candAfter = await prisma.candidate.findUnique({ where: { id: cand.id } });
  const salaryAudit = (await prisma.auditLog.findMany({ where: { event_type: "candidate.salary_changed" } })).map((r) => JSON.parse(r.payload ?? "{}"));
  check(11, "the salary went to the candidate's own field, traced to call A, the one call that said it (D-87)", candAfter?.expected_salary === 35_000_000 && salaryAudit.some((p) => p.call_id === jobA.callId), { expected_salary: candAfter?.expected_salary, audit_call_ids: salaryAudit.map((p) => p.call_id ?? null) });
  const day = vnToday();
  const tt = await api("GET", `/api/call-recorder/time-tracker?from=${day}&to=${day}&ta=me`, { cookie: ta.cookie });
  check(11, "the call appears in the TA's time-tracker data for the period", tt.status === 200 && (tt.json?.summary?.screenings ?? 0) >= 1, { status: tt.status, screenings: tt.json?.summary?.screenings, excluded: tt.json?.summary?.excluded, table: tt.json?.summary?.table });

  // ---- 12. Import recording (D-171): a stereo file and a mono file, each for a Solace call ----
  const cand2 = await prisma.candidate.create({ data: { name: "Lê Văn Nhập", phone: "0900 000 002", owner_id: ta.id } });
  const app2 = await prisma.application.create({ data: { job_code: JOB_CODE, candidate_id: cand2.id, current_stage: "phone_screen", owner_id: ta.id } });
  const writeImport = (buf, hoursAgo) => {
    mkdirSync(dirname(IMPORT_FILE), { recursive: true });
    writeFileSync(IMPORT_FILE, buf);
    const t = (Date.now() - hoursAgo * 3600_000) / 1000;
    utimesSync(IMPORT_FILE, t, t);
    return Math.round(t * 1000);
  };
  const importInApp = async (label) => {
    await page.eval(`document.getElementById("btn-import").click(), true`);
    await waitFor(`${label}: import dialog`, () => page.eval(`!document.getElementById("import-dialog").hidden`), 10_000, 200);
    await page.eval(`document.getElementById("import-choose").click(), true`);
    return waitFor(`${label}: import done`, async () => {
      const s = await page.eval(`(() => { const e = document.getElementById("import-status"); return e.classList.contains("pass") || e.classList.contains("notyet") ? e.className + "|" + e.textContent : null; })()`);
      return s;
    }, 60_000, 300);
  };
  // 12a. stereo (left = TA, right = candidate), recorded two hours ago
  const sD = await api("POST", "/api/call-recorder/sessions", { cookie: ta.cookie, body: { application_id: app2.id, dial_mode: "self_dial" } });
  const D = sD.json?.session_id;
  const mtimeD = writeImport(toneWav([[[330, 0.3, 1.8], [440, 4.2, 5.7]], [[660, 2.1, 3.6], [880, 6.3, 7.8]]], 8.5), 2);
  await sendLinkToRunningApp(sD.json.deep_link);
  await waitFor("D recording", async () => (await appState()) === "recording", 30_000, 200);
  const importButtonD = await page.eval(`(() => { const b = document.getElementById("btn-import"); return b.hidden ? null : b.textContent; })()`);
  const statusD = await importInApp("import D");
  check(12, "during a live Solace call the window offers 'Import a recording instead…'; the stereo import is accepted", importButtonD === "Import a recording instead…" && /^wizard-status pass\|Imported\./.test(statusD), { button: importButtonD, status: statusD });
  const jobD = await waitStage(D, ["sent", "failed"], 300_000);
  const folderD = join(RECORDINGS, D);
  const filesD = existsSync(folderD) ? readdirSync(folderD) : [];
  const markerD = JSON.parse(readFileSync(join(folderD, "ta-call-recorder.call.json"), "utf8"));
  check(12, "the live recording was replaced: the call folder holds the import copy and the marker (3 days from the import), no live .webm", filesD.includes(`${D}.import.wav`) && !filesD.some((f) => f.endsWith(".webm")) && Math.abs(Date.parse(markerD.ended_at) - Date.now()) < 10 * 60_000, filesD);
  const recD = await prisma.callRecord.findUnique({ where: { session_id: D } });
  const segD = JSON.parse(recD?.segments ?? "[]");
  const repairsD = JSON.parse(recD?.repairs ?? "{}");
  check(12, "stereo import sent with the session: left = ta, right = candidate, has_content true", jobD.stage === "sent" && recD?.application_id === app2.id && segD.length >= 2 && segD[0].speaker === "ta" && segD.some((t) => t.speaker === "candidate") && recD?.has_content === true, { stage: jobD.stage, speakers: segD.map((t) => t.speaker) });
  check(12, "the file's own time is used (started_at = modified time − length) and Solace stores it, flagged clock_suspect (2 h before the session)", Math.abs(recD.started_at.getTime() - (mtimeD - 8500)) < 2000 && Math.abs(recD.ended_at.getTime() - mtimeD) < 2000 && repairsD.clock_suspect === true, { started_at: recD?.started_at, ended_at: recD?.ended_at, repairs: repairsD });
  // 12b. mono (both voices on one channel), recorded ten minutes ago: speaker labels, then the TA's choice
  const sE = await api("POST", "/api/call-recorder/sessions", { cookie: ta.cookie, body: { application_id: app2.id, dial_mode: "3cx" } });
  const E = sE.json?.session_id;
  writeImport(toneWav([[[330, 0.3, 2.5], [660, 3.0, 5.5], [440, 6.0, 8.0]]], 9), 10 / 60);
  await sendLinkToRunningApp(sE.json.deep_link);
  await waitFor("E recording", async () => (await appState()) === "recording", 30_000, 200);
  const statusE = await importInApp("import E");
  const waitingE = await waitStage(E, ["transcribed", "failed"], 300_000);
  check(12, "a mono import is transcribed with speaker labels and waits for the TA's voice choice (nothing sent yet)", /Gemini now tells the two voices apart/.test(statusE) && waitingE.speakersNeeded === true && gemini.log.some((e) => e.kind === "diarize") && !(await prisma.callRecord.findUnique({ where: { session_id: E } })), { status: statusE, stage: waitingE.stage, speakersNeeded: waitingE.speakersNeeded });
  await page.eval(`window.__taRecorderCommand("speakers"), true`);
  await waitFor("voice dialog", () => page.eval(`!document.getElementById("speakers-dialog").hidden`), 10_000, 200);
  const preview = await page.eval(`Array.from(document.querySelectorAll("#speakers-chunks li")).map((l) => l.textContent)`);
  await page.eval(`document.querySelector('input[name="speaker-me"][value="A"]').click(), document.getElementById("speakers-send").click(), true`);
  const jobE = await waitStage(E, ["sent", "failed"], 120_000);
  const recE = await prisma.callRecord.findUnique({ where: { session_id: E } });
  const segE = JSON.parse(recE?.segments ?? "[]");
  check(12, "after 'My voice is A' the mono call is sent: A = ta, B = candidate, the salary sentence is the candidate's", jobE.stage === "sent" && segE.map((t) => t.speaker).join(",") === "ta,candidate,ta" && /30 triệu/.test(segE[1]?.text ?? "") && recE?.has_content === true, { preview, stage: jobE.stage, speakers: segE.map((t) => t.speaker) });

  // ---- 10. Retention: the app restarted with its clock 73 h ahead ----
  await stopApp();
  const before = callFolders();
  await startApp([`--e2e-clock-offset-ms=${RETENTION_OFFSET_MS}`], "app-run2-clock+73h");
  await waitFor("the sweep to delete the call folders", async () => callFolders().length === 0, 60_000, 500);
  const sweepLine = await waitFor("retention.sweep in app.log", () => readFileSync(join(USER_DATA, "app.log"), "utf8").split("\n").filter((l) => l.includes("retention.sweep ")).at(-1), 20_000);
  check(10, "with the clock 73 h ahead, the start-up sweep deletes every call folder, the two imports too (permanently, fs.rm)", before.length === 5 && callFolders().length === 0 && /"deleted":5/.test(sweepLine), { before: before.length, after: callFolders().length, log: sweepLine.trim() });
  const recA = await api("GET", `/api/call-recorder/records/${jobA.callId}`, { cookie: ta.cookie });
  check(10, "Solace keeps the transcript", recA.status === 200 && JSON.stringify(recA.json).includes("35 triệu"), { status: recA.status });
  await stopApp();

  // ---- 4/6. Nothing but JSON ever went to Solace ----
  const nonJson = proxy.log.filter((e) => e.bytes > 0 && !(e.json && e.content_type === "application/json"));
  const biggest = Math.max(0, ...proxy.log.map((e) => e.bytes));
  check(4, "everything the app sent to Solace was small JSON (no audio, no file)", nonJson.length === 0 && biggest < 20_000 && proxy.log.every((e) => e.path.startsWith("/api/call-recorder/")), { requests: proxy.log.length, paths: [...new Set(proxy.log.map((e) => e.path))], biggest_bytes: biggest });

  // ---- 8c. No LLM key → ai_ready false ----
  const status1 = await api("GET", "/api/call-recorder/assistant/status", { cookie: ta.cookie });
  await stopSolace();
  solace = await startSolace(false, "solace-no-llm");
  const status2 = await api("GET", "/api/call-recorder/assistant/status", { cookie: ta.cookie });
  check(8, "/assistant/status: ai_ready true with the fake key, false with no LLM key", status1.json?.ai_ready === true && status2.status === 200 && status2.json?.ai_ready === false, { with_key: status1.json, without_key: status2.json });
}

async function cleanup() {
  try { page?.close(); } catch { /* ignore */ }
  for (const c of [...children]) kill(c);
  for (const s of servers) await new Promise((done) => s.close(() => done()));
  await prisma?.$disconnect().catch(() => undefined);
  for (const [name, port] of Object.entries(PORT)) {
    const open = await waitFor(`port ${port} closed`, async () => !(await portOpen(port)), 20_000).then(() => false, () => true);
    say(`port ${port} (${name}) ${open ? "STILL OPEN" : "closed"}`);
  }
  if (existsSync(join(USER_DATA, "app.log"))) cpSync(join(USER_DATA, "app.log"), join(LOGS, "app.log"));
  if (!KEEP_WORK && existsSync(WORK) && resolve(WORK).startsWith(resolve(tmpdir())) && /tacr-e2e-/.test(WORK)) {
    rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    say("work folder deleted");
  }
}

let failure = null;
try {
  await run();
} catch (e) {
  failure = e;
  say(`ERROR ${e?.stack ?? e}`);
} finally {
  writeFileSync(join(LOGS, "proxy-to-solace.json"), JSON.stringify(proxy?.log ?? [], null, 2));
  writeFileSync(join(LOGS, "fake-gemini.json"), JSON.stringify(gemini?.log ?? [], null, 2));
  writeFileSync(join(LOGS, "fake-llm.json"), JSON.stringify(llm?.log ?? [], null, 2));
  await cleanup();
  const table = Object.entries(STEPS).map(([n, name]) => {
    const mine = checks.filter((c) => c.step === Number(n));
    const ok = mine.length > 0 && mine.every((c) => c.ok);
    return { step: Number(n), name, result: ok ? "PASS" : mine.length ? "FAIL" : "NOT RUN", checks: mine.length };
  });
  writeFileSync(join(LOGS, "results.json"), JSON.stringify({ at: new Date().toISOString(), failure: failure ? String(failure.message ?? failure) : null, steps: table, checks }, null, 2));
  say("---------- summary ----------");
  for (const r of table) say(`${String(r.step).padStart(2)}. ${r.name.padEnd(36)} ${r.result} (${r.checks} checks)`);
  const allOk = !failure && table.every((r) => r.result === "PASS");
  say(allOk ? "ALL STEPS PASS" : "SOME STEPS FAILED");
  process.exit(allOk ? 0 : 1);
}
