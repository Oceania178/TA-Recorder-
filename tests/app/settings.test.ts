import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRecordingsDir, defaultRecordingsDir } from "../../src/main/recordingsFolder";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "../../src/main/appSettings";
import { dotBitmap } from "../../src/main/trayIcon";

const ENV = { OneDrive: "C:\\Users\\ta\\OneDrive - VNG Group JSC", OneDriveCommercial: "C:\\Users\\ta\\OneDrive - VNG Group JSC" };

describe("recordings folder", () => {
  it("defaults to Documents\\Sound Recordings\\TA Call Recorder", () => {
    expect(defaultRecordingsDir("C:\\Users\\ta\\Documents")).toBe("C:\\Users\\ta\\Documents\\Sound Recordings\\TA Call Recorder");
  });

  it("accepts a normal local folder", () => {
    expect(checkRecordingsDir("C:\\Users\\ta\\Documents\\Sound Recordings\\TA Call Recorder", ENV)).toEqual({ ok: true });
  });

  it("refuses a folder under OneDrive (T20)", () => {
    for (const p of ["C:\\Users\\ta\\OneDrive - VNG Group JSC\\Calls", "c:\\users\\TA\\onedrive - vng group jsc", "D:\\Data\\OneDrive - Other Co\\x"]) {
      const r = checkRecordingsDir(p, ENV);
      expect(r.ok, p).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/OneDrive/);
    }
  });

  it("does not mistake a sibling folder for OneDrive", () => {
    expect(checkRecordingsDir("C:\\Users\\ta\\OneDriveArchive\\x", { OneDrive: "C:\\Users\\ta\\OneDrive" }).ok).toBe(true);
    expect(checkRecordingsDir("C:\\Users\\ta\\OneDrive\\x", { OneDrive: "C:\\Users\\ta\\OneDrive" }).ok).toBe(false);
  });

  it("refuses a relative path", () => {
    expect(checkRecordingsDir("recordings", ENV).ok).toBe(false);
  });
});

describe("app settings file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tacr-settings-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("gives defaults when there is no file", async () => {
    expect(await loadSettings(join(dir, "settings.json"))).toEqual(DEFAULT_SETTINGS);
  });

  it("saves and loads", async () => {
    const file = join(dir, "settings.json");
    await saveSettings(file, { recordingsDir: "D:\\Calls", micProcessing: true });
    expect(await loadSettings(file)).toEqual({ recordingsDir: "D:\\Calls", micProcessing: true });
  });

  it("falls back to defaults on a damaged file or wrong types", async () => {
    const file = join(dir, "settings.json");
    await writeFile(file, "{not json");
    expect(await loadSettings(file)).toEqual(DEFAULT_SETTINGS);
    await writeFile(file, JSON.stringify({ recordingsDir: 5, micProcessing: "yes" }));
    expect(await loadSettings(file)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("tray icon bitmap", () => {
  it("draws a coloured dot on a transparent square (BGRA)", () => {
    const buf = dotBitmap(16, { r: 220, g: 38, b: 38 });
    expect(buf.length).toBe(16 * 16 * 4);
    const px = (x: number, y: number) => Array.from(buf.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4));
    expect(px(8, 8)).toEqual([38, 38, 220, 255]);
    expect(px(0, 0)[3]).toBe(0);
  });
});
