// D-140 while the app is closed: the `--sweep` mode the logon task runs, and the Task Scheduler task itself.
// schtasks is NEVER run here: the command runner is a fake that records its arguments.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSweepMode, runHeadlessSweep } from "../../src/main/sweepMode";
import { CLEANUP_TASK_NAME, cleanupTaskXml, ensureCleanupTask, removeCleanupTask, type CommandRunner } from "../../src/main/cleanupTask";
import { writeCallMarker } from "../../src/core";

const DAY = 24 * 3600_000;
const NOW = Date.parse("2026-10-29T03:00:00Z");
const OLD = "cmh2x9k0a0001qz8v7y6t5r4e";
const BUSY = "cmh2x9k0a0002qz8v7y6t5r4e";
const FRESH = "20261029-100000-a1b2c3";

let base: string;
let userData: string;
let recordings: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "tacr-sweep-"));
  userData = join(base, "userData");
  recordings = join(base, "Calls");
  await mkdir(userData, { recursive: true });
  await writeFile(join(userData, "settings.json"), JSON.stringify({ recordingsDir: recordings, micProcessing: false }));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function call(id: string, endedAtMs: number): Promise<void> {
  const folder = join(recordings, id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${id}.webm`), "audio");
  await writeCallMarker(folder, { id, startedAt: new Date(endedAtMs - 60_000).toISOString(), endedAt: new Date(endedAtMs).toISOString() });
}

describe("--sweep mode", () => {
  it("is recognised on the command line", () => {
    expect(isSweepMode(["C:\\app.exe", "--sweep"])).toBe(true);
    expect(isSweepMode(["C:\\app.exe"])).toBe(false);
  });

  it("deletes expired calls headless (a stale busy stage is ignored: it holds the lock), keeps fresh ones, leaves the queue file alone", async () => {
    await call(OLD, NOW - 4 * DAY);
    await call(BUSY, NOW - 4 * DAY);
    await call(FRESH, NOW - 1 * DAY);
    const queueText = JSON.stringify({ version: 1, jobs: [{ id: BUSY, stage: "transcribing" }, { id: OLD, stage: "sent" }] });
    await writeFile(join(userData, "queue.json"), queueText);
    await mkdir(join(userData, "secrets", "tickets"), { recursive: true });
    await writeFile(join(userData, "secrets", "tickets", `${OLD}.bin`), "encrypted");
    const logs: string[] = [];

    const r = await runHeadlessSweep({ userDataDir: userData, documentsDir: join(base, "Documents"), env: {}, nowMs: NOW, log: (e, f) => void logs.push(`${e} ${JSON.stringify(f)}`) });

    expect(r).toMatchObject({ ran: true, deleted: 2, kept: 1, busy: 0, errors: 0 });
    expect(existsSync(join(recordings, OLD))).toBe(false);
    expect(existsSync(join(recordings, BUSY))).toBe(false);
    expect(existsSync(join(recordings, FRESH))).toBe(true);
    expect(existsSync(join(userData, "secrets", "tickets", `${OLD}.bin`))).toBe(false);
    expect(await readFile(join(userData, "queue.json"), "utf8")).toBe(queueText);
    expect(logs.join("\n")).toContain('"deleted":2');
    expect(logs.join("\n")).not.toContain(OLD);
    expect(logs.join("\n")).not.toContain(recordings);
  });

  it("still deletes old calls in a folder OneDrive has since taken over (deleting is always safe, I2a)", async () => {
    await call(OLD, NOW - 4 * DAY);
    const r = await runHeadlessSweep({ userDataDir: userData, documentsDir: join(base, "Documents"), env: { OneDrive: base }, nowMs: NOW });
    expect(r).toMatchObject({ ran: true, deleted: 1 });
    expect(existsSync(join(recordings, OLD))).toBe(false);
  });

  it("works when there is no queue file and no recordings folder yet", async () => {
    const r = await runHeadlessSweep({ userDataDir: userData, documentsDir: join(base, "Documents"), env: {}, nowMs: NOW });
    expect(r).toMatchObject({ ran: true, deleted: 0 });
  });
});

describe("the Windows Task Scheduler task", () => {
  const EXE = "C:\\Users\\ta\\AppData\\Local\\Programs\\ta-call-recorder\\TA Call Recorder.exe";

  it("creates a per-user task from an XML file: at this user's logon and daily, no admin, then deletes the file", async () => {
    const calls: { file: string; args: readonly string[]; xml: Buffer }[] = [];
    const xmlFile = join(base, "cleanup-task.xml");
    const run: CommandRunner = async (file, args) => {
      calls.push({ file, args, xml: readFileSync(xmlFile) });
      return { code: 0 };
    };
    const ok = await ensureCleanupTask({ run, exePath: EXE, userId: "VNG\\ta", xmlFile });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("schtasks.exe");
    expect(calls[0].args).toEqual(["/Create", "/TN", CLEANUP_TASK_NAME, "/XML", xmlFile, "/F"]);
    expect(CLEANUP_TASK_NAME).toBe("TA Call Recorder cleanup");
    // schtasks reads the XML as UTF-16 with a byte-order mark.
    expect([...calls[0].xml.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    const xml = calls[0].xml.subarray(2).toString("utf16le");
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<UserId>VNG\\ta</UserId>");
    expect(xml).toContain("<ScheduleByDay>");
    expect(xml).toContain(`<Command>${EXE}</Command>`);
    expect(xml).toContain("<Arguments>--sweep</Arguments>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(existsSync(xmlFile)).toBe(false);
  });

  it("escapes the exe path and extra arguments for XML", () => {
    const xml = cleanupTaskXml({ command: "C:\\A&B <x>\\app.exe", arguments: '"C:\\dev\\app" --sweep', userId: "PC\\a&b" });
    expect(xml).toContain("<Command>C:\\A&amp;B &lt;x&gt;\\app.exe</Command>");
    expect(xml).toContain("<Arguments>&quot;C:\\dev\\app&quot; --sweep</Arguments>");
    expect(xml).toContain("<UserId>PC\\a&amp;b</UserId>");
  });

  it("reports failure when schtasks fails, and still deletes the XML file", async () => {
    const xmlFile = join(base, "cleanup-task.xml");
    const ok = await ensureCleanupTask({ run: async () => ({ code: 1 }), exePath: EXE, userId: "VNG\\ta", xmlFile });
    expect(ok).toBe(false);
    expect(existsSync(xmlFile)).toBe(false);
  });

  it("removes the task by name", async () => {
    const seen: (readonly string[])[] = [];
    await removeCleanupTask(async (_f, args) => {
      seen.push(args);
      return { code: 0 };
    });
    expect(seen).toEqual([["/Delete", "/TN", CLEANUP_TASK_NAME, "/F"]]);
  });

  it("the uninstaller removes the same task (NSIS customUnInstall)", async () => {
    const nsh = await readFile(join(__dirname, "..", "..", "build", "installer.nsh"), "utf8");
    expect(nsh).toContain("!macro customUnInstall");
    expect(nsh).toContain(`schtasks.exe /Delete /TN "${CLEANUP_TASK_NAME}" /F`);
    const pkg = JSON.parse(await readFile(join(__dirname, "..", "..", "package.json"), "utf8"));
    expect(pkg.build.nsis.include).toBe("build/installer.nsh");
  });
});
