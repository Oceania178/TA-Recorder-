// The settings file, the secret store (Gemini key, upload tickets) and the settings actions the window uses.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type AppSettings } from "../../src/main/appSettings";
import { SecretStore, type SafeStorageLike } from "../../src/main/secretStore";
import { clearGeminiKey, setGeminiKey, setGeminiModel, setSolaceAddress, type SettingsHost } from "../../src/main/settingsActions";
import { defaultRecordingsDir } from "../../src/main/recordingsFolder";

const KEY = "AIzaSyFAKE-test-key-1234wxyz";
const TICKET = "U".repeat(43);
const SID = "cmh2x9k0a0001qz8v7y6t5r4e";

/** Stands in for Electron safeStorage (DPAPI): reversible, but the stored bytes never contain the plain text. */
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
    decryptString: (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
  };
}

async function allFileText(dir: string): Promise<string> {
  let out = "";
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out += (await readFile(join(e.parentPath ?? (e as unknown as { path: string }).path, e.name))).toString("latin1");
  }
  return out;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tacr-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("settings file", () => {
  it("has every new field with a safe default", async () => {
    expect(await loadSettings(join(dir, "settings.json"))).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({
      recordingsDir: null, micProcessing: false, solaceBaseUrl: null, geminiModel: null,
      noticeAcceptedAt: null, wizardDoneAt: null, cleanupTaskFor: null, knownRecordingsDirs: [],
    });
  });

  it("keeps the old two-field file working", async () => {
    const file = join(dir, "settings.json");
    await writeFile(file, JSON.stringify({ recordingsDir: "D:\\Calls", micProcessing: true }));
    expect(await loadSettings(file)).toEqual({ ...DEFAULT_SETTINGS, recordingsDir: "D:\\Calls", micProcessing: true });
  });

  it("drops a bad field and keeps the good ones", async () => {
    const file = join(dir, "settings.json");
    await writeFile(file, JSON.stringify({ recordingsDir: 5, micProcessing: true, solaceBaseUrl: "https://solace.vng.vn" }));
    expect(await loadSettings(file)).toEqual({ ...DEFAULT_SETTINGS, micProcessing: true, solaceBaseUrl: "https://solace.vng.vn" });
  });

  it("never writes anything but the known fields (no key, no ticket can land in the JSON)", async () => {
    const file = join(dir, "settings.json");
    const sneaky = { ...DEFAULT_SETTINGS, solaceBaseUrl: "https://solace.vng.vn", geminiKey: KEY, ticket: TICKET } as unknown as AppSettings;
    await saveSettings(file, sneaky);
    const text = await readFile(file, "utf8");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(TICKET);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });
});

describe("default recordings folder", () => {
  it("uses Documents when Documents is local", () => {
    expect(defaultRecordingsDir("C:\\Users\\ta\\Documents", { LOCALAPPDATA: "C:\\Users\\ta\\AppData\\Local" })).toBe(
      "C:\\Users\\ta\\Documents\\Sound Recordings\\TA Call Recorder",
    );
  });

  it("falls back to %LOCALAPPDATA% when Documents is inside OneDrive", () => {
    const env = { OneDrive: "C:\\Users\\ta\\OneDrive - VNG Group JSC", LOCALAPPDATA: "C:\\Users\\ta\\AppData\\Local" };
    expect(defaultRecordingsDir("C:\\Users\\ta\\OneDrive - VNG Group JSC\\Documents", env)).toBe(
      "C:\\Users\\ta\\AppData\\Local\\TA Call Recorder\\Recordings",
    );
  });
});

describe("SecretStore", () => {
  it("keeps the Gemini key encrypted on disk, shows only the last 4 characters, and clears it", async () => {
    const s = new SecretStore({ dir: join(dir, "secrets"), crypto: fakeSafeStorage() });
    expect(await s.getGeminiKey()).toBeNull();
    expect(await s.setGeminiKey(`  ${KEY}  `)).toEqual({ ok: true });
    expect(await s.getGeminiKey()).toBe(KEY);
    expect(await s.geminiKeyHint()).toBe("•••• wxyz");
    expect(await allFileText(dir)).not.toContain(KEY);
    // A fresh store (app restart) reads it back.
    const again = new SecretStore({ dir: join(dir, "secrets"), crypto: fakeSafeStorage() });
    expect(await again.getGeminiKey()).toBe(KEY);
    await again.clearGeminiKey();
    expect(await again.getGeminiKey()).toBeNull();
    expect(await again.geminiKeyHint()).toBeNull();
  });

  it("refuses an empty or odd key, and refuses to store any key without Windows encryption", async () => {
    const s = new SecretStore({ dir: join(dir, "secrets"), crypto: fakeSafeStorage() });
    expect((await s.setGeminiKey("  ")).ok).toBe(false);
    expect((await s.setGeminiKey("has space inside key")).ok).toBe(false);
    const plain = new SecretStore({ dir: join(dir, "plain"), crypto: fakeSafeStorage(false) });
    const r = await plain.setGeminiKey(KEY);
    expect(r.ok).toBe(false);
    expect(existsSync(join(dir, "plain"))).toBe(false);
  });

  it("holds an upload ticket per session, encrypted, and forgets it", async () => {
    const s = new SecretStore({ dir: join(dir, "secrets"), crypto: fakeSafeStorage() });
    await s.saveTicket(SID, TICKET, { sendBy: "2026-11-01T00:00:00.000Z", dialMode: "3cx", origin: "https://solace.vng.vn", linkTicketHash: "h" });
    expect(await s.getTicket(SID)).toBe(TICKET);
    expect(await s.heldTicket(SID)).toEqual({ sendBy: "2026-11-01T00:00:00.000Z", dialMode: "3cx", origin: "https://solace.vng.vn", linkTicketHash: "h" });
    expect(await allFileText(dir)).not.toContain(TICKET);
    const again = new SecretStore({ dir: join(dir, "secrets"), crypto: fakeSafeStorage() });
    expect(await again.getTicket(SID)).toBe(TICKET);
    await again.forgetTicket(SID);
    expect(await again.getTicket(SID)).toBeNull();
    expect(await again.heldTicket(SID)).toBeNull();
  });

  it("keeps a ticket in memory only when Windows encryption is missing", async () => {
    const s = new SecretStore({ dir: join(dir, "secrets"), crypto: fakeSafeStorage(false) });
    await s.saveTicket(SID, TICKET, { sendBy: "2026-11-01T00:00:00.000Z", dialMode: "self_dial", origin: "https://solace.vng.vn", linkTicketHash: "h" });
    expect(await s.getTicket(SID)).toBe(TICKET);
    expect(existsSync(join(dir, "secrets"))).toBe(false);
  });

  it("refuses a session id that could leave its folder", async () => {
    const s = new SecretStore({ dir: join(dir, "secrets"), crypto: fakeSafeStorage() });
    await expect(s.saveTicket("..\\..\\x", TICKET, { sendBy: "2026-11-01T00:00:00.000Z", dialMode: "3cx", origin: "https://solace.vng.vn", linkTicketHash: "h" })).rejects.toThrow();
  });

  it("prunes tickets whose send window has closed", async () => {
    const s = new SecretStore({ dir: join(dir, "secrets"), crypto: fakeSafeStorage() });
    await s.saveTicket(SID, TICKET, { sendBy: "2026-10-01T00:00:00.000Z", dialMode: "3cx", origin: "https://solace.vng.vn", linkTicketHash: "h" });
    await s.saveTicket("cmh2x9k0a0002qz8v7y6t5r4e", TICKET, { sendBy: "2026-12-01T00:00:00.000Z", dialMode: "3cx", origin: "https://solace.vng.vn", linkTicketHash: "h" });
    expect(await s.pruneExpired(Date.parse("2026-10-29T00:00:00Z"))).toBe(1);
    const again = new SecretStore({ dir: join(dir, "secrets"), crypto: fakeSafeStorage() });
    expect(await again.getTicket(SID)).toBeNull();
    expect(await again.getTicket("cmh2x9k0a0002qz8v7y6t5r4e")).toBe(TICKET);
  });
});

describe("settings actions", () => {
  function host(initial: Partial<AppSettings> = {}, recording = false) {
    let current: AppSettings = { ...DEFAULT_SETTINGS, ...initial };
    const keyEvents: string[] = [];
    const secrets = new SecretStore({ dir: join(dir, "secrets"), crypto: fakeSafeStorage() });
    const h: SettingsHost = {
      get: () => current,
      save: async (patch) => {
        current = { ...current, ...patch };
        await saveSettings(join(dir, "settings.json"), current);
      },
      isRecording: () => recording,
      secrets,
      dev: false,
      keyChanged: () => void keyEvents.push("changed"),
    };
    return { h, keyEvents, now: () => current };
  }

  it("pins only an https Solace origin", async () => {
    const { h, now } = host();
    expect(await setSolaceAddress(h, "http://solace.vng.vn")).toMatch(/https/);
    expect(await setSolaceAddress(h, "https://solace.vng.vn/path")).toMatch(/only the address/i);
    expect(now().solaceBaseUrl).toBeNull();
    expect(await setSolaceAddress(h, " https://Solace.VNG.vn/ ")).toBeNull();
    expect(now().solaceBaseUrl).toBe("https://solace.vng.vn");
  });

  it("allows http://localhost only in a dev build", async () => {
    const { h } = host();
    expect(await setSolaceAddress(h, "http://localhost:4000")).toMatch(/https/);
    expect(await setSolaceAddress({ ...h, dev: true }, "http://localhost:4000")).toBeNull();
  });

  it("validates the Gemini model and goes back to the default when emptied", async () => {
    const { h, now } = host();
    expect(await setGeminiModel(h, "models/../x")).toMatch(/model/i);
    expect(await setGeminiModel(h, "gemini-2.5-flash")).toBeNull();
    expect(now().geminiModel).toBe("gemini-2.5-flash");
    expect(await setGeminiModel(h, "")).toBeNull();
    expect(now().geminiModel).toBeNull();
  });

  it("stores the key in the secret store, never in the settings file, and says the key changed", async () => {
    const { h, keyEvents } = host();
    expect(await setGeminiKey(h, KEY)).toBeNull();
    expect(await h.secrets.getGeminiKey()).toBe(KEY);
    expect(keyEvents).toEqual(["changed"]);
    const settingsText = existsSync(join(dir, "settings.json")) ? await readFile(join(dir, "settings.json"), "utf8") : "";
    expect(settingsText).not.toContain(KEY);
    await clearGeminiKey(h);
    expect(await h.secrets.getGeminiKey()).toBeNull();
  });

  it("does not change the Solace address during a recording", async () => {
    const { h } = host({}, true);
    expect(await setSolaceAddress(h, "https://solace.vng.vn")).toMatch(/after this recording/);
  });
});
