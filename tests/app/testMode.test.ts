// D-165 (Triet 30/10/2026): the installed app records only when opened from Solace's button. Recording without a
// Solace session (shortcut, tray, window Start) needs "Test mode" in Settings; such a call is "Local only":
// transcribed on the laptop, never sent to Solace. The notice gate (D-162) still comes first.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecorderController } from "../../src/main/controller";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../../src/main/appSettings";
import { requestLocalStart, TEST_MODE_OFF_MESSAGE } from "../../src/main/startGate";
import { NOTICE_FIRST_MESSAGE } from "../../src/main/deepLinkFlow";
import { setTestMode, type SettingsHost } from "../../src/main/settingsActions";
import { SecretStore } from "../../src/main/secretStore";
import { trayTooltip } from "../../src/main/trayIcon";

const MIC = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
const SID = "cmh2x9k0a0001qz8v7y6t5r4e";
const ROOT = join(__dirname, "..", "..");

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "tacr-testmode-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function controller() {
  return new RecorderController({
    userDataDir: join(base, "userData"),
    documentsDir: join(base, "Documents"),
    env: {},
    appVersion: "0.1.0",
    onStateChange: () => undefined,
  });
}

describe("the Test mode setting", () => {
  it("is off by default and saved in settings.json (it is not a secret)", async () => {
    expect(DEFAULT_SETTINGS.testMode).toBe(false);
    const file = join(base, "settings.json");
    expect((await loadSettings(file)).testMode).toBe(false);
    await saveSettings(file, { ...DEFAULT_SETTINGS, testMode: true });
    expect((await loadSettings(file)).testMode).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8")).testMode).toBe(true);
  });

  it("an older settings file without it means off; a wrong type means off", async () => {
    const file = join(base, "settings.json");
    await writeFile(file, JSON.stringify({ recordingsDir: null, micProcessing: false }));
    expect((await loadSettings(file)).testMode).toBe(false);
    await writeFile(file, JSON.stringify({ testMode: "yes" }));
    expect((await loadSettings(file)).testMode).toBe(false);
  });

  it("is switched from Settings, but not in the middle of a recording", async () => {
    let current = { ...DEFAULT_SETTINGS };
    let recording = false;
    const h: SettingsHost = {
      get: () => current,
      save: async (patch) => void (current = { ...current, ...patch }),
      isRecording: () => recording,
      secrets: new SecretStore({ dir: join(base, "secrets"), crypto: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" } }),
      dev: false,
      keyChanged: () => undefined,
    };
    expect(await setTestMode(h, true)).toBeNull();
    expect(current.testMode).toBe(true);
    recording = true;
    expect(await setTestMode(h, false)).toMatch(/after this recording/);
    expect(current.testMode).toBe(true);
  });
});

describe("D-165: recording without a Solace session needs Test mode", () => {
  it("refuses a window / tray / shortcut start with Test mode off, with the D-165 message", async () => {
    const c = controller();
    await c.init();
    await c.updateSettings({ noticeAcceptedAt: "2026-10-30T00:00:00.000Z" });
    expect(TEST_MODE_OFF_MESSAGE).toBe("Start the call from Solace (Call & record). To record without Solace, turn on Test mode in Settings.");
    expect(await c.beginCall(MIC)).toEqual({ ok: false, code: "test_mode", message: TEST_MODE_OFF_MESSAGE });
    expect(c.guard.state).toBe("idle");
  });

  it("records Local only with Test mode on", async () => {
    const c = controller();
    await c.init();
    await c.updateSettings({ noticeAcceptedAt: "2026-10-30T00:00:00.000Z", testMode: true });
    expect(await c.beginCall(MIC)).toMatchObject({ ok: true, linked: false, dialMode: null });
  });

  it("a Solace link records with Test mode off", async () => {
    const c = controller();
    await c.init();
    await c.updateSettings({ noticeAcceptedAt: "2026-10-30T00:00:00.000Z" });
    c.armLinkedCall({ sessionId: SID, dialMode: "3cx", sendBy: "2026-11-02T00:00:00.000Z" });
    expect(await c.beginCall(MIC, "linked")).toMatchObject({ ok: true, callId: SID, linked: true });
  });

  it("the notice gate (D-162) still comes first", async () => {
    const c = controller();
    await c.init();
    await c.updateSettings({ testMode: true });
    expect(await c.beginCall(MIC)).toMatchObject({ ok: false, code: "notice", message: NOTICE_FIRST_MESSAGE });
  });

  it("tray and shortcut starts are refused before reaching the page, without opening the set-up check", () => {
    const seen: string[] = [];
    const base = { noticeAccepted: () => true, isRecording: () => false, disarm: () => seen.push("disarm"), start: () => seen.push("start"), refuse: (m: string, w: boolean) => seen.push(`refuse:${m}:${w}`) };
    requestLocalStart({ ...base, testMode: () => false });
    expect(seen).toEqual([`refuse:${TEST_MODE_OFF_MESSAGE}:false`]);
    seen.length = 0;
    requestLocalStart({ ...base, noticeAccepted: () => false, testMode: () => false });
    expect(seen).toEqual([`refuse:${NOTICE_FIRST_MESSAGE}:true`]);
    seen.length = 0;
    requestLocalStart({ ...base, testMode: () => true });
    expect(seen).toEqual(["disarm", "start"]);
  });
});

describe("the TEST MODE badge", () => {
  it("is in the tray tooltip while Test mode is on", () => {
    expect(trayTooltip("idle", false)).toBe("TA Call Recorder — ready");
    expect(trayTooltip("idle", true)).toBe("TA Call Recorder — ready · TEST MODE");
    expect(trayTooltip("recording", true)).toBe("TA Call Recorder — recording · TEST MODE");
  });

  it("has a place in the window, the floating bar and Settings", async () => {
    const html = await readFile(join(ROOT, "src", "renderer", "static", "recorder.html"), "utf8");
    expect(html).toContain('id="test-mode-badge"');
    expect(html).toContain('id="test-mode"');
    expect(html).toContain("TEST MODE");
    const bar = await readFile(join(ROOT, "src", "renderer", "static", "bar.html"), "utf8");
    expect(bar).toContain('id="test-mode-badge"');
  });
});

describe("the e2e run switches Test mode on for its local call (step 9)", () => {
  it("run.mjs turns it on with the window's Settings switch, after checking a start is refused without it", async () => {
    const run = await readFile(join(ROOT, "scripts", "e2e", "run.mjs"), "utf8");
    const step9 = run.slice(run.indexOf("---- 9."));
    const refused = step9.indexOf("Test mode in Settings");
    const on = step9.indexOf('getElementById("test-mode").click()');
    const start = step9.indexOf('__taRecorderCommand("start")', on);
    expect(refused).toBeGreaterThan(-1);
    expect(on).toBeGreaterThan(refused);
    expect(start).toBeGreaterThan(on);
  });
});

