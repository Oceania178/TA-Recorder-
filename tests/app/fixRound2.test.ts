// Fix round 2 (controller answers): a real uninstall also removes the app's own data and the Gemini key; a
// drive letter that is a network share or not connected is refused as the recordings folder.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUninstallPurge } from "../../src/main/sweepMode";
import { checkRecordingsDir } from "../../src/main/recordingsFolder";
import { writeCallMarker } from "../../src/core";

const SID = "cmh2x9k0a0001qz8v7y6t5r4e";
let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "tacr-fix2-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("uninstall purge removes the app's data too", () => {
  it("deletes recordings, then settings, queue, log and the secret store (Gemini key and tickets)", async () => {
    const userData = join(base, "userData");
    const rec = join(base, "Calls");
    await mkdir(join(userData, "secrets", "tickets"), { recursive: true });
    await writeFile(join(userData, "secrets", "gemini-key.bin"), "encrypted key");
    await writeFile(join(userData, "secrets", "tickets", `${SID}.bin`), "encrypted ticket");
    await writeFile(join(userData, "settings.json"), JSON.stringify({ recordingsDir: rec, knownRecordingsDirs: [rec] }));
    await writeFile(join(userData, "queue.json"), JSON.stringify({ version: 1, jobs: [] }));
    await writeFile(join(userData, "queue.json.damaged-1"), "x");
    await writeFile(join(userData, "app.log"), "line\n");
    await writeFile(join(userData, "app.log.1"), "old\n");
    const folder = join(rec, SID);
    await mkdir(folder, { recursive: true });
    await writeCallMarker(folder, { id: SID, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() });

    const r = await runUninstallPurge({ userDataDir: userData, documentsDir: join(base, "Documents"), env: {} });

    expect(r.deleted).toBe(1);
    expect(existsSync(folder)).toBe(false);
    for (const name of ["secrets", "settings.json", "queue.json", "queue.json.damaged-1", "app.log", "app.log.1"]) {
      expect(existsSync(join(userData, name)), name).toBe(false);
    }
  });

  it("writes nothing back afterwards (no log line recreates app.log)", async () => {
    const userData = join(base, "userData");
    await mkdir(userData, { recursive: true });
    const events: string[] = [];
    await runUninstallPurge({ userDataDir: userData, documentsDir: join(base, "Documents"), env: {}, log: (e) => void events.push(e) });
    expect(events).toEqual([]);
    expect(existsSync(join(userData, "app.log"))).toBe(false);
  });

  it("electron-builder also deletes the app data folder on a real uninstall, and the notice says so", async () => {
    const pkg = JSON.parse(await readFile(join(__dirname, "..", "..", "package.json"), "utf8"));
    expect(pkg.build.nsis.deleteAppDataOnUninstall).toBe(true);
    const html = await readFile(join(__dirname, "..", "..", "src", "renderer", "static", "recorder.html"), "utf8");
    expect(html).toContain("Uninstalling deletes your recordings and the app's settings, including your Gemini key.");
  });
});

describe("recordings folder: only a drive on this laptop", () => {
  it("refuses a drive letter that does not resolve (disconnected)", () => {
    const r = checkRecordingsDir("Y:\\Calls", {}, { driveRoot: () => null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Pick a folder on this laptop.");
  });

  it("says the same for a network share and a UNC path", () => {
    for (const r of [
      checkRecordingsDir("Z:\\Calls", {}, { driveRoot: () => "\\\\nas\\team\\" }),
      checkRecordingsDir("\\\\nas\\team\\Calls", {}),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("Pick a folder on this laptop.");
    }
  });

  it("still accepts a local drive", () => {
    expect(checkRecordingsDir("C:\\Calls", {}, { driveRoot: () => "C:\\" }).ok).toBe(true);
  });
});
