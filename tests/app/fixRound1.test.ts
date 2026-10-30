// Fix round 1 (APP review), app side: I1 notice gate, I2 retention everywhere, minors M2–M4, M7–M11, the clock
// warning, the 4-hour cap, the second-instance path and the fuses.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RecorderController } from "../../src/main/controller";
import { DeepLinkFlow, NOTICE_FIRST_MESSAGE, clockWarning, hashLinkTicket, type DeepLinkFlowDeps } from "../../src/main/deepLinkFlow";
import { requestLocalStart } from "../../src/main/startGate";
import { CallJobs, type CallJobsDeps } from "../../src/main/callJobs";
import { runHeadlessSweep, runUninstallPurge, isPurgeMode } from "../../src/main/sweepMode";
import { sweepInProgress } from "../../src/main/inProgressSweep";
import { checkRecordingsDir } from "../../src/main/recordingsFolder";
import { keepCleanupTask, CLEANUP_TASK_NAME, type CommandRunner } from "../../src/main/cleanupTask";
import { isAllowedRendererRequest, isOwnPage, permissionAllowed, permissionCheckAllowed } from "../../src/main/pagePolicy";
import { handleSecondInstance } from "../../src/main/secondInstance";
import { longCallStatus, LONG_CALL_STOP_MS, LONG_CALL_WARN_MS } from "../../src/renderer/longCall";
import { Secret, writeCallMarker, type CheckResult, type FetchLike, type RequestInitLike } from "../../src/core";
import type { HeldTicket } from "../../src/main/secretStore";
import { build } from "../core/signals";

const MIC = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
const SID = "cmh2x9k0a0001qz8v7y6t5r4e";
const LINK_TICKET = "L".repeat(43);
const UPLOAD_TICKET = "U".repeat(43);
const SOLACE = "https://solace.vng.vn";
const SEND_BY = "2026-11-01T03:00:00.000Z";
const DAY = 24 * 3600_000;
const link = (ticket = LINK_TICKET) => `tacallrecorder://start?session_id=${SID}&ticket=${ticket}&dial_mode=3cx`;

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "tacr-fix1-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function controller(env: Record<string, string> = {}) {
  return new RecorderController({
    userDataDir: join(base, "userData"),
    documentsDir: join(base, "Documents"),
    env,
    appVersion: "0.1.0",
    onStateChange: () => undefined,
  });
}

// ---------------------------------------------------------------- I1
describe("I1: nothing records until the D-126 notice is accepted", () => {
  it("the controller refuses every start (button, tray, shortcut and Solace link all end here) until accepted", async () => {
    const c = controller();
    await c.init();
    expect(c.noticeAccepted()).toBe(false);
    const local = await c.beginCall(MIC);
    expect(local).toEqual({ ok: false, code: "notice", message: NOTICE_FIRST_MESSAGE });
    expect(NOTICE_FIRST_MESSAGE).toBe("Open Set-up check and accept the notice first.");
    c.armLinkedCall({ sessionId: SID, dialMode: "3cx", sendBy: SEND_BY });
    expect(await c.beginCall(MIC, "linked")).toMatchObject({ ok: false, code: "notice" });
    expect(c.guard.state).toBe("idle");
    await c.updateSettings({ noticeAcceptedAt: "2026-10-29T00:00:00.000Z", testMode: true });
    expect((await c.beginCall(MIC)).ok).toBe(true);
  });

  it("tray and shortcut starts are refused before reaching the page, and the set-up check opens", () => {
    const seen: string[] = [];
    requestLocalStart({
      noticeAccepted: () => false,
      testMode: () => true,
      isRecording: () => false,
      disarm: () => seen.push("disarm"),
      start: () => seen.push("start"),
      refuse: (message, openWizard) => seen.push(`refuse:${message}:${openWizard}`),
    });
    expect(seen).toEqual([`refuse:${NOTICE_FIRST_MESSAGE}:true`]);
  });

  it("a Solace link before acceptance is refused without any ticket check", async () => {
    let checks = 0;
    const flow = new DeepLinkFlow({
      noticeAccepted: () => false,
      isRecording: () => false,
      getBaseUrl: () => SOLACE,
      checkTicket: async () => {
        checks++;
        return { ok: false, kind: "refused" };
      },
      tickets: { held: async () => null, save: async () => undefined },
      alreadyRecorded: () => false,
      start: () => undefined,
    });
    expect(await flow.handle(link())).toEqual({ ok: false, code: "notice", message: NOTICE_FIRST_MESSAGE });
    expect(checks).toBe(0);
  });
});

// ---------------------------------------------------------------- M3, M4, clock
function flowWith(over: Partial<DeepLinkFlowDeps> & { held?: HeldTicket | null; check?: CheckResult; now?: () => number }) {
  let checks = 0;
  const saved: HeldTicket[] = [];
  const started: string[] = [];
  const flow = new DeepLinkFlow({
    noticeAccepted: () => true,
    isRecording: () => false,
    getBaseUrl: () => SOLACE,
    checkTicket: async () => {
      checks++;
      return over.check ?? { ok: true, sessionId: SID, dialMode: "3cx", uploadTicket: new Secret(UPLOAD_TICKET), sendBy: SEND_BY, serverTime: null };
    },
    tickets: { held: async () => over.held ?? null, save: async (_id, _t, h) => void saved.push(h) },
    alreadyRecorded: () => false,
    start: (s) => void started.push(s.sessionId),
    now: over.now ?? (() => Date.parse("2026-10-29T03:00:00Z")),
  });
  return { flow, saved, started, checks: () => checks };
}

describe("M2/M3: the held ticket remembers where it was checked and which link it came from", () => {
  it("stores the checked origin and a hash of the link ticket (never the link ticket itself)", async () => {
    const t = flowWith({});
    await t.flow.handle(link());
    expect(t.saved).toEqual([{ sendBy: SEND_BY, dialMode: "3cx", origin: SOLACE, linkTicketHash: hashLinkTicket(LINK_TICKET) }]);
    expect(JSON.stringify(t.saved)).not.toContain(LINK_TICKET);
  });

  it("reuses a held ticket only for the same link ticket; another ticket is checked with Solace", async () => {
    const held: HeldTicket = { sendBy: SEND_BY, dialMode: "3cx", origin: SOLACE, linkTicketHash: hashLinkTicket(LINK_TICKET) };
    const same = flowWith({ held });
    expect((await same.flow.handle(link())).ok).toBe(true);
    expect(same.checks()).toBe(0);
    const forged = flowWith({ held, check: { ok: false, kind: "already_checked", sendBy: SEND_BY } });
    expect(await forged.flow.handle(link("F".repeat(43)))).toMatchObject({ ok: false, code: "already_used" });
    expect(forged.checks()).toBe(1);
    expect(forged.started).toEqual([]);
  });
});

describe("clock warning (controller addition)", () => {
  it("warns when Solace's clock and the laptop differ by more than 2 minutes", async () => {
    const now = Date.parse("2026-10-29T03:00:00Z");
    expect(clockWarning("2026-10-29T03:01:30Z", now)).toBeNull();
    expect(clockWarning("2026-10-29T03:05:00Z", now)).toBe("Your laptop clock is off by 5 min — fix Windows time, Solace may reject the call");
    expect(clockWarning("2026-10-29T02:57:00Z", now)).toBe("Your laptop clock is off by 3 min — fix Windows time, Solace may reject the call");
    expect(clockWarning(null, now)).toBeNull();
    const t = flowWith({ check: { ok: true, sessionId: SID, dialMode: "3cx", uploadTicket: new Secret(UPLOAD_TICKET), sendBy: SEND_BY, serverTime: "2026-10-29T03:10:00Z" } });
    const r = await t.flow.handle(link());
    expect(r).toMatchObject({ ok: true, clockWarning: "Your laptop clock is off by 10 min — fix Windows time, Solace may reject the call" });
  });
});

describe("M4: an armed Solace session never attaches to a later local start", () => {
  it("a local start drops the armed session; a linked start after it expired is refused", async () => {
    const c = controller();
    await c.init();
    await c.updateSettings({ noticeAcceptedAt: "2026-10-29T00:00:00.000Z", testMode: true });
    c.armLinkedCall({ sessionId: SID, dialMode: "3cx", sendBy: SEND_BY });
    const local = await c.beginCall(MIC, "local");
    expect(local).toMatchObject({ ok: true, linked: false });
    if (local.ok) await c.endCall(local.callId, 10);
    expect(await c.beginCall(MIC, "linked")).toMatchObject({ ok: false });
    c.armLinkedCall({ sessionId: SID, dialMode: "3cx", sendBy: SEND_BY }, Date.now() - 120_000);
    expect(await c.beginCall(MIC, "linked")).toMatchObject({ ok: false });
  });

  it("tray and shortcut starts disarm before pressing Start", () => {
    const seen: string[] = [];
    requestLocalStart({ noticeAccepted: () => true, testMode: () => true, isRecording: () => false, disarm: () => seen.push("disarm"), start: () => seen.push("start"), refuse: () => seen.push("refuse") });
    expect(seen).toEqual(["disarm", "start"]);
  });
});

// ---------------------------------------------------------------- I2
async function callFolder(root: string, id: string, endedAtMs: number, inProgress = false): Promise<string> {
  const folder = inProgress ? join(root, ".in-progress", id) : join(root, id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${id}.webm${inProgress ? ".part" : ""}`), "audio");
  await writeCallMarker(folder, { id, startedAt: new Date(endedAtMs - 60_000).toISOString(), endedAt: inProgress ? null : new Date(endedAtMs).toISOString() });
  if (inProgress) {
    const t = new Date(endedAtMs);
    await utimes(join(folder, `${id}.webm.part`), t, t);
    await utimes(join(folder, "ta-call-recorder.call.json"), t, t);
  }
  return folder;
}

describe("I2a: every recordings folder ever used is remembered and swept", () => {
  it("the controller keeps the old folder in the list when the TA picks a new one", async () => {
    const c = controller();
    await c.init();
    const first = c.recordingsDir();
    expect(await c.setRecordingsDir(join(base, "Calls"))).toBeNull();
    expect(c.knownRecordingsDirs().sort()).toEqual([first, join(base, "Calls")].sort());
    const again = controller();
    await again.init();
    expect(again.knownRecordingsDirs().sort()).toEqual([first, join(base, "Calls")].sort());
  });

  it("the app's sweep deletes old calls in every known folder, and stuck .in-progress leftovers (I2b)", async () => {
    const now = Date.parse("2026-10-29T03:00:00Z");
    const a = join(base, "A");
    const b = join(base, "B");
    await callFolder(a, "20261020-100000-aaaaaa", now - 4 * DAY);
    await callFolder(b, "20261020-100000-bbbbbb", now - 4 * DAY);
    await callFolder(b, "20261020-100000-cccccc", now - 4 * DAY, true);
    await callFolder(b, "20261028-100000-dddddd", now - 1 * DAY, true);
    const jobs = await CallJobs.open(jobsDeps(now));
    const r = await jobs.sweep([a, b]);
    expect(r).toMatchObject({ deleted: 3 });
    expect(existsSync(join(a, "20261020-100000-aaaaaa"))).toBe(false);
    expect(existsSync(join(b, "20261020-100000-bbbbbb"))).toBe(false);
    expect(existsSync(join(b, ".in-progress", "20261020-100000-cccccc"))).toBe(false);
    expect(existsSync(join(b, ".in-progress", "20261028-100000-dddddd"))).toBe(true);
    jobs.close();
  });

  it("never touches the call being recorded right now, however old its files look", async () => {
    const now = Date.parse("2026-10-29T03:00:00Z");
    await callFolder(base, "20261020-100000-eeeeee", now - 4 * DAY, true);
    const r = await sweepInProgress({ root: base, nowMs: now, skipId: "20261020-100000-eeeeee" });
    expect(r.deleted).toBe(0);
    expect(existsSync(join(base, ".in-progress", "20261020-100000-eeeeee"))).toBe(true);
  });
});

function jobsDeps(now: number, over: Partial<CallJobsDeps> = {}): CallJobsDeps {
  return {
    queueFile: join(base, "userData", "queue.json"),
    secrets: { getGeminiKey: async () => null, getTicket: async () => null, heldTicket: async () => null, forgetTicket: async () => undefined },
    getBaseUrl: () => SOLACE,
    getModel: () => "gemini-3.5-transcribe",
    fetch: async () => {
      throw new Error("no network in tests");
    },
    loadPcm: async () => null,
    appVersion: "0.1.0",
    now: () => now,
    setTimer: () => null,
    clearTimer: () => undefined,
    ...over,
  };
}

describe("I2a/b/d: the --sweep mode", () => {
  it("sweeps every known folder and stuck leftovers, ignoring stale 'busy' jobs (it holds the single-instance lock)", async () => {
    const now = Date.parse("2026-10-29T03:00:00Z");
    const userData = join(base, "userData");
    const a = join(base, "A");
    const b = join(base, "B");
    await mkdir(userData, { recursive: true });
    await writeFile(join(userData, "settings.json"), JSON.stringify({ recordingsDir: b, knownRecordingsDirs: [a, b] }));
    await callFolder(a, SID, now - 4 * DAY);
    await callFolder(b, "20261020-100000-cccccc", now - 4 * DAY, true);
    await writeFile(join(userData, "queue.json"), JSON.stringify({ version: 1, jobs: [{ id: SID, stage: "transcribing" }] }));
    const r = await runHeadlessSweep({ userDataDir: userData, documentsDir: join(base, "Documents"), env: {}, nowMs: now });
    expect(r).toMatchObject({ ran: true, deleted: 2 });
    expect(existsSync(join(a, SID))).toBe(false);
    expect(existsSync(join(b, ".in-progress", "20261020-100000-cccccc"))).toBe(false);
  });
});

describe("I2c: uninstalling deletes the recordings", () => {
  it("--uninstall-purge deletes every marker-guarded call folder in every known folder, nothing else", async () => {
    const now = Date.now();
    const userData = join(base, "userData");
    const a = join(base, "A");
    const b = join(base, "B");
    await mkdir(join(userData, "secrets", "tickets"), { recursive: true });
    await writeFile(join(userData, "secrets", "tickets", `${SID}.bin`), "x");
    await writeFile(join(userData, "settings.json"), JSON.stringify({ recordingsDir: b, knownRecordingsDirs: [a, b] }));
    await callFolder(a, SID, now); // fresh: still deleted on uninstall
    await callFolder(b, "20261028-100000-dddddd", now, true);
    await mkdir(join(b, "My notes"), { recursive: true });
    await writeFile(join(b, "My notes", "keep.txt"), "mine");
    expect(isPurgeMode(["app.exe", "--uninstall-purge"])).toBe(true);
    const r = await runUninstallPurge({ userDataDir: userData, documentsDir: join(base, "Documents"), env: {} });
    expect(r.deleted).toBe(2);
    expect(existsSync(join(a, SID))).toBe(false);
    expect(existsSync(join(b, ".in-progress", "20261028-100000-dddddd"))).toBe(false);
    expect(existsSync(join(b, "My notes", "keep.txt"))).toBe(true);
    expect(existsSync(join(userData, "secrets", "tickets", `${SID}.bin`))).toBe(false);
  });

  it("the uninstaller runs the purge on a real uninstall only (not on an update), and the notice says so", async () => {
    // Where and when the uninstaller runs the purge is pinned in fixRound3.test.ts (I-R1).
    const html = await readFile(join(__dirname, "..", "..", "src", "renderer", "static", "recorder.html"), "utf8");
    expect(html).toContain("Uninstalling deletes your recordings and the app's settings, including your Gemini key.");
  });
});

// ---------------------------------------------------------------- M2 in the queue, M9
describe("M2: the upload goes to the address the ticket was checked at", () => {
  it("sends to the held ticket's origin even if Settings changed after the check", async () => {
    const now = Date.parse("2026-10-29T03:00:00Z");
    const folder = join(base, "rec", SID);
    await mkdir(folder, { recursive: true });
    await writeCallMarker(folder, { id: SID, startedAt: new Date(now - 60_000).toISOString(), endedAt: new Date(now).toISOString() });
    await writeFile(join(folder, `${SID}.left.webm`), "L");
    await writeFile(join(folder, `${SID}.right.webm`), "R");
    const urls: string[] = [];
    const fetch: FetchLike = async (url: string, _init: RequestInitLike) => {
      urls.push(url);
      if (url.includes("googleapis")) {
        return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "xin chào" }] }, finishReason: "STOP" }] }) };
      }
      return { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ call_id: "c1" }) };
    };
    const tone = build(16_000, [{ kind: "silence", ms: 300 }, { kind: "tone", ms: 800 }, { kind: "silence", ms: 300 }], 9);
    await mkdir(join(base, "userData"), { recursive: true });
    const jobs = await CallJobs.open(jobsDeps(now, {
      fetch,
      getBaseUrl: () => "https://evil.example",
      loadPcm: async () => ({ left: tone, right: new Float32Array(tone.length), sampleRate: 16_000 }),
      secrets: {
        getGeminiKey: async () => "AIzaFAKE-key-0001",
        getTicket: async () => UPLOAD_TICKET,
        heldTicket: async () => ({ sendBy: SEND_BY, dialMode: "3cx", origin: SOLACE, linkTicketHash: "x" }),
        forgetTicket: async () => undefined,
      },
      geminiSleep: async () => undefined,
      geminiMaxAttempts: 1,
    }));
    await jobs.add({ id: SID, folder, startedAtMs: now - 60_000, endedAtMs: now, session: { sessionId: SID, dialMode: "3cx", sendBy: SEND_BY } });
    expect(jobs.get(SID)?.stage).toBe("sent");
    expect(urls.filter((u) => !u.includes("googleapis"))).toEqual([`${SOLACE}/api/call-recorder/transcripts`]);
    jobs.close();
  });
});

describe("M9: a folder that is only temporarily missing never loses its jobs or tickets", () => {
  it("keeps jobs whose recordings root is not there (unplugged drive), drops those whose own folder is gone", async () => {
    const { JobQueue } = await import("../../src/core");
    await mkdir(join(base, "userData"), { recursive: true });
    await mkdir(join(base, "here"), { recursive: true });
    const q = await JobQueue.open(join(base, "userData", "queue.json"));
    const job = (id: string, folder: string) => ({ id, sessionId: null, dialMode: null, folder, startedAt: "2026-10-29T10:00:00+07:00", endedAt: "2026-10-29T10:00:03+07:00", sendBy: null });
    await q.add(job("20261029-100000-aaaaaa", join(base, "unplugged", "20261029-100000-aaaaaa")));
    await q.add(job("20261029-100000-bbbbbb", join(base, "here", "20261029-100000-bbbbbb")));
    const forgotten: string[] = [];
    const jobs = await CallJobs.open(jobsDeps(Date.now(), { secrets: { getGeminiKey: async () => null, getTicket: async () => null, heldTicket: async () => null, forgetTicket: async (id) => void forgotten.push(id) } }));
    expect(jobs.list().map((j) => j.id)).toEqual(["20261029-100000-aaaaaa"]);
    expect(forgotten).toEqual(["20261029-100000-bbbbbb"]);
    jobs.close();
  });
});

// ---------------------------------------------------------------- M7
describe("M7: recordings folder must be on this laptop", () => {
  it("refuses UNC paths, root-relative paths and mapped network drives", () => {
    expect(checkRecordingsDir("\\\\server\\share\\Calls", {}).ok).toBe(false);
    expect(checkRecordingsDir("\\Calls", {}).ok).toBe(false);
    const mapped = checkRecordingsDir("Z:\\Calls", {}, { driveRoot: (r) => (r.toUpperCase() === "Z:\\" ? "\\\\nas\\team\\" : r) });
    expect(mapped.ok).toBe(false);
    if (!mapped.ok) expect(mapped.message).toMatch(/network/i);
    expect(checkRecordingsDir("C:\\Calls", {}, { driveRoot: (r) => r }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------- M8
describe("M8: the cleanup task is re-created when it is missing", () => {
  it("asks schtasks whether the task exists and creates it again when it does not", async () => {
    const calls: (readonly string[])[] = [];
    let exists = false;
    const run: CommandRunner = async (_f, args) => {
      calls.push(args);
      return { code: args[0] === "/Query" ? (exists ? 0 : 1) : 0 };
    };
    let created = 0;
    const create = async () => {
      created++;
      return true;
    };
    expect(await keepCleanupTask({ run, recordedFor: "exe|1", forThis: "exe|1", create })).toEqual({ ok: true, created: true });
    expect(calls[0]).toEqual(["/Query", "/TN", CLEANUP_TASK_NAME]);
    exists = true;
    expect(await keepCleanupTask({ run, recordedFor: "exe|1", forThis: "exe|1", create })).toEqual({ ok: true, created: false });
    expect(await keepCleanupTask({ run, recordedFor: "exe|0", forThis: "exe|1", create })).toEqual({ ok: true, created: true });
    expect(created).toBe(2);
  });

  it("the uninstaller keeps the task during an update", async () => {
    const nsh = await readFile(join(__dirname, "..", "..", "build", "installer.nsh"), "utf8");
    expect(nsh.slice(nsh.indexOf("!macro customUnInstall"))).toContain("!insertmacro taRealUninstall");
  });
});

// ---------------------------------------------------------------- M10, M11, IPC sender check
describe("M10/M11: pages, requests and permissions", () => {
  const dir = "C:\\app\\resources\\app.asar\\dist\\renderer";
  const own = pathToFileURL(join(dir, "recorder.html")).href;

  it("knows its own pages, and not lookalike folders", () => {
    expect(isOwnPage(own, dir)).toBe(true);
    expect(isOwnPage(pathToFileURL(`${dir}-evil\\recorder.html`).href, dir)).toBe(false);
    expect(isOwnPage("file://server/share/recorder.html", dir)).toBe(false);
    expect(isOwnPage("https://example.com/", dir)).toBe(false);
  });

  it("lets the pages load only the app's own files (no SMB, no web)", () => {
    expect(isAllowedRendererRequest(own, dir)).toBe(true);
    expect(isAllowedRendererRequest(pathToFileURL(join(dir, "recorder.css")).href, dir)).toBe(true);
    expect(isAllowedRendererRequest("file://server/share/x.js", dir)).toBe(false);
    expect(isAllowedRendererRequest(pathToFileURL("C:\\Windows\\win.ini").href, dir)).toBe(false);
    expect(isAllowedRendererRequest("https://example.com/", dir)).toBe(false);
    expect(isAllowedRendererRequest("blob:file:///abc", dir)).toBe(true);
    expect(isAllowedRendererRequest("data:image/png;base64,AAAA", dir)).toBe(true);
  });

  it("grants the microphone (audio, never a camera) and system-audio capture, to own pages only", () => {
    expect(permissionAllowed("media", ["audio"], true)).toBe(true);
    expect(permissionAllowed("media", ["audio", "video"], true)).toBe(false);
    expect(permissionAllowed("media", ["video"], true)).toBe(false);
    // getDisplayMedia (system audio) arrives as "media" with no media types (checked on this laptop).
    expect(permissionAllowed("media", [], true)).toBe(true);
    expect(permissionAllowed("media", undefined, true)).toBe(false);
    expect(permissionAllowed("display-capture", [], true)).toBe(true);
    expect(permissionAllowed("media", ["audio"], false)).toBe(false);
    expect(permissionAllowed("notifications", [], true)).toBe(false);
    expect(permissionCheckAllowed("media", "audio", true)).toBe(true);
    expect(permissionCheckAllowed("media", "video", true)).toBe(false);
    expect(permissionCheckAllowed("media", "audio", false)).toBe(false);
  });

  it("the floating bar has its own preload with only its two functions", async () => {
    const src = await readFile(join(__dirname, "..", "..", "src", "main", "barPreload.ts"), "utf8");
    expect(src).toContain("sendBarCommand");
    expect(src).toContain("onStatus");
    expect(src).not.toMatch(/beginCall|appendChunk|setGeminiKey|openCallFolder/);
  });
});

describe("second instance", () => {
  it("--sweep only sweeps; a link goes to the deep-link hook; argv is never logged", () => {
    const seen: string[] = [];
    const deps = { sweep: () => seen.push("sweep"), deepLink: (u: string) => seen.push(`link:${u.length}`), show: () => seen.push("show"), log: (e: string, f: Record<string, unknown>) => seen.push(`log:${e}:${JSON.stringify(f)}`) };
    handleSecondInstance(["app.exe", "--sweep"], deps);
    expect(seen).toEqual(["log:second_instance.sweep:{}", "sweep"]);
    seen.length = 0;
    handleSecondInstance(["app.exe", link()], deps);
    expect(seen).toEqual(["log:second_instance.link:{}", `link:${link().length}`, "show"]);
    expect(seen.join(" ")).not.toContain(LINK_TICKET);
    seen.length = 0;
    handleSecondInstance(["app.exe"], deps);
    expect(seen).toEqual(["show"]);
  });
});

// ---------------------------------------------------------------- I3 cap
describe("I3: a forgotten Stop is capped", () => {
  it("warns at 3 h 50 and stops at 4 h", () => {
    expect(LONG_CALL_WARN_MS).toBe((3 * 60 + 50) * 60_000);
    expect(LONG_CALL_STOP_MS).toBe(4 * 3600_000);
    expect(longCallStatus(LONG_CALL_WARN_MS - 1)).toBe("ok");
    expect(longCallStatus(LONG_CALL_WARN_MS)).toBe("warn");
    expect(longCallStatus(LONG_CALL_STOP_MS)).toBe("stop");
  });
});

// ---------------------------------------------------------------- M11 fuses
describe("M11: Electron fuses are set on the packaged exe", () => {
  const require = createRequire(__filename);
  const { flipFuses, WANTED_FUSES } = require("../../build/fuses.cjs") as {
    flipFuses(b: Buffer, want: Record<number, "0" | "1">): { before: string; after: string };
    WANTED_FUSES: Record<number, "0" | "1">;
  };
  const SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";

  it("turns RunAsNode, NODE_OPTIONS and inspect off; cookie encryption and only-load-from-asar on", () => {
    const exe = Buffer.concat([Buffer.from("MZ...."), Buffer.from(SENTINEL), Buffer.from([1, 8]), Buffer.from("10110001"), Buffer.from("....")]);
    const r = flipFuses(exe, WANTED_FUSES);
    expect(r.before).toBe("10110001");
    expect(r.after).toBe("01000101");
    expect(exe.toString("latin1")).toContain(`${SENTINEL}\u0001\u000801000101`);
  });

  it("refuses an exe without the fuse wire", () => {
    expect(() => flipFuses(Buffer.from("not electron"), WANTED_FUSES)).toThrow();
  });

  it("is hooked into electron-builder as afterPack", async () => {
    const pkg = JSON.parse(await readFile(join(__dirname, "..", "..", "package.json"), "utf8"));
    expect(pkg.build.afterPack).toBe("build/fuses.cjs");
  });
});
