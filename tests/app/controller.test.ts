import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecorderController } from "../../src/main/controller";
import type { RecorderState } from "../../src/main/ipcTypes";
import { MARKER_FILE, sweepRecordings } from "../../src/core/retention";

const MIC = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
let base: string;
let states: RecorderState[];

function make(env: Record<string, string> = {}) {
  return new RecorderController({
    userDataDir: join(base, "userData"),
    documentsDir: join(base, "Documents"),
    env,
    appVersion: "0.1.0",
    onStateChange: (s) => states.push(s),
  });
}
const recordings = () => join(base, "Documents", "Sound Recordings", "TA Call Recorder");

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "tacr-ctrl-"));
  states = [];
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("RecorderController", () => {
  it("records a whole call into three files plus metadata", async () => {
    const c = make();
    await c.init();
    await c.updateSettings({ noticeAcceptedAt: "2026-10-29T00:00:00.000Z", testMode: true });
    const begin = await c.beginCall(MIC);
    expect(begin.ok).toBe(true);
    if (!begin.ok) return;
    expect(c.guard.state).toBe("starting");
    c.noteCaptureStarted();
    await c.appendChunk(begin.callId, "stereo", new TextEncoder().encode("S").buffer);
    await c.appendChunk(begin.callId, "left", new Uint8Array([76]));
    await c.markPause(begin.callId, "pause", 1000);
    await c.markPause(begin.callId, "resume", 1000);
    const end = await c.endCall(begin.callId, 5000);
    expect(end).toEqual({ ok: true, callId: begin.callId });
    const files = (await readdir(join(recordings(), begin.callId))).sort();
    expect(files).toEqual([`${begin.callId}.call.json`, `${begin.callId}.left.webm`, `${begin.callId}.right.webm`, `${begin.callId}.webm`, MARKER_FILE].sort());
    expect(states).toEqual(["starting", "recording", "paused", "recording", "stopping", "idle"]);
  });

  it("leaves call folders that core's 3-day sweep recognises and deletes (D-140)", async () => {
    const c = make();
    await c.init();
    await c.updateSettings({ noticeAcceptedAt: "2026-10-29T00:00:00.000Z", testMode: true });
    const b = await c.beginCall(MIC);
    if (!b.ok) throw new Error("start failed");
    c.noteCaptureStarted();
    await c.endCall(b.callId, 1000);
    const second = await c.beginCall(MIC);
    if (!second.ok) throw new Error("second start failed");
    const report = await sweepRecordings({ root: recordings(), nowMs: Date.now() + 4 * 24 * 3600_000, isBusy: () => false });
    expect(report.deleted).toBe(1);
    expect(existsSync(join(recordings(), b.callId))).toBe(false);
    expect(existsSync(join(recordings(), ".in-progress", second.callId))).toBe(true);
  });

  it("refuses a second start while recording (D-39)", async () => {
    const c = make();
    await c.init();
    await c.updateSettings({ noticeAcceptedAt: "2026-10-29T00:00:00.000Z", testMode: true });
    const first = await c.beginCall(MIC);
    const second = await c.beginCall(MIC);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toMatch(/already recording/i);
  });

  it("refuses to record into OneDrive (T20)", async () => {
    const c = make({ OneDrive: join(base, "Documents") });
    await c.init();
    await c.updateSettings({ noticeAcceptedAt: "2026-10-29T00:00:00.000Z", testMode: true });
    const r = await c.beginCall(MIC);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/OneDrive/);
    expect(c.guard.state).toBe("idle");
    expect(c.settingsView().dirProblem).toMatch(/OneDrive/);
  });

  it("refuses chunks for a call that is not running, and wrong tracks", async () => {
    const c = make();
    await c.init();
    await c.updateSettings({ noticeAcceptedAt: "2026-10-29T00:00:00.000Z", testMode: true });
    const b = await c.beginCall(MIC);
    if (!b.ok) throw new Error("start failed");
    await expect(c.appendChunk("20200101-000000-ffffff", "stereo", new ArrayBuffer(1))).rejects.toThrow(/refused/);
    await expect(c.appendChunk(b.callId, "centre", new ArrayBuffer(1))).rejects.toThrow(/refused/);
    await expect(c.appendChunk(b.callId, "stereo", "text")).rejects.toThrow(/refused/);
  });

  it("keeps what was recorded when the recorder page crashes (R6)", async () => {
    const c = make();
    await c.init();
    await c.updateSettings({ noticeAcceptedAt: "2026-10-29T00:00:00.000Z", testMode: true });
    const b = await c.beginCall(MIC);
    if (!b.ok) throw new Error("start failed");
    await c.appendChunk(b.callId, "stereo", new Uint8Array([1, 2, 3]).buffer);
    await c.recorderLost();
    expect(c.guard.state).toBe("idle");
    const meta = JSON.parse(await readFile(join(recordings(), b.callId, `${b.callId}.call.json`), "utf8"));
    expect(meta.status).toBe("recovered");
    expect(c.settingsView().notices[0]).toMatch(/Recovered 1 recording/);
  });

  it("recovers a crash leftover at startup and says so once", async () => {
    const id = "20261029-140305-a1b2c3";
    const dir = join(recordings(), ".in-progress", id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${id}.webm.part`), "SSS");
    const c = make();
    await c.init();
    await c.updateSettings({ noticeAcceptedAt: "2026-10-29T00:00:00.000Z", testMode: true });
    expect(existsSync(join(recordings(), id, `${id}.webm`))).toBe(true);
    expect(c.settingsView().notices).toHaveLength(1);
    expect(c.settingsView().notices).toHaveLength(0);
  });

  it("does not let the folder change during a recording, and refuses OneDrive", async () => {
    const c = make({ OneDrive: join(base, "OD") });
    await c.init();
    await c.updateSettings({ noticeAcceptedAt: "2026-10-29T00:00:00.000Z", testMode: true });
    expect(await c.setRecordingsDir(join(base, "OD", "x"))).toMatch(/OneDrive/);
    expect(await c.setRecordingsDir(join(base, "Calls"))).toBeNull();
    expect(c.recordingsDir()).toBe(join(base, "Calls"));
    await c.beginCall(MIC);
    expect(await c.setRecordingsDir(join(base, "Other"))).toMatch(/after this recording stops/);
  });
});

describe("RecorderController: calls linked to Solace (Step 5) and the hand-off to the queue (Step 2)", () => {
  const SID = "cmh2x9k0a0001qz8v7y6t5r4e";
  const SESSION = { sessionId: SID, dialMode: "self_dial" as const, sendBy: "2026-11-01T03:00:00.000Z" };

  function makeWithSaved(saved: unknown[]) {
    return new RecorderController({
      userDataDir: join(base, "userData"),
      documentsDir: join(base, "Documents"),
      env: {},
      appVersion: "0.1.0",
      onStateChange: (s) => states.push(s),
      onCallSaved: async (call) => void saved.push(call),
    });
  }

  it("records an armed Solace session under the session id and hands it to the queue", async () => {
    const saved: any[] = [];
    const c = makeWithSaved(saved);
    await c.init();
    await c.updateSettings({ noticeAcceptedAt: "2026-10-29T00:00:00.000Z", testMode: true });
    c.armLinkedCall(SESSION);
    const b = await c.beginCall(MIC, "linked");
    expect(b).toEqual({ ok: true, callId: SID, linked: true, dialMode: "self_dial" });
    c.noteCaptureStarted();
    await c.endCall(SID, 3000);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: SID, folder: join(recordings(), SID), session: SESSION });
    expect(saved[0].endedAtMs).toBeGreaterThanOrEqual(saved[0].startedAtMs);
    const meta = JSON.parse(await readFile(join(recordings(), SID, `${SID}.call.json`), "utf8"));
    expect(meta.session).toEqual({ session_id: SID, dial_mode: "self_dial", send_by: SESSION.sendBy });
  });

  it("records a call without a session as local only, and the next call is local again", async () => {
    const saved: any[] = [];
    const c = makeWithSaved(saved);
    await c.init();
    await c.updateSettings({ noticeAcceptedAt: "2026-10-29T00:00:00.000Z", testMode: true });
    const b = await c.beginCall(MIC);
    expect(b).toMatchObject({ ok: true, linked: false, dialMode: null });
    if (!b.ok) return;
    expect(b.callId).not.toBe(SID);
    c.noteCaptureStarted();
    await c.endCall(b.callId, 1000);
    expect(saved[0]).toMatchObject({ id: b.callId, session: null });
  });

  it("drops an armed session that never started (e.g. the mic was blocked)", async () => {
    const c = makeWithSaved([]);
    await c.init();
    await c.updateSettings({ noticeAcceptedAt: "2026-10-29T00:00:00.000Z", testMode: true });
    c.armLinkedCall(SESSION, Date.now() - 120_000);
    expect(await c.beginCall(MIC, "linked")).toMatchObject({ ok: false });
    const b = await c.beginCall(MIC);
    expect(b).toMatchObject({ ok: true, linked: false });
  });

  it("hands a crash-recovered Solace call to the queue with its session", async () => {
    const saved: any[] = [];
    const c = makeWithSaved(saved);
    await c.init();
    await c.updateSettings({ noticeAcceptedAt: "2026-10-29T00:00:00.000Z", testMode: true });
    c.armLinkedCall(SESSION);
    const b = await c.beginCall(MIC, "linked");
    if (!b.ok) throw new Error("start failed");
    await c.appendChunk(b.callId, "left", new Uint8Array([1, 2, 3]).buffer);
    await c.recorderLost();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: SID, session: SESSION });
  });

  it("knows a session already has a call folder", async () => {
    const c = makeWithSaved([]);
    await c.init();
    await c.updateSettings({ noticeAcceptedAt: "2026-10-29T00:00:00.000Z", testMode: true });
    expect(c.hasCall(SID)).toBe(false);
    await mkdir(join(recordings(), SID), { recursive: true });
    expect(c.hasCall(SID)).toBe(true);
    expect(c.hasCall("..")).toBe(true);
  });
});
