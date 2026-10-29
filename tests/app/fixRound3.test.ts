// Fix round 3 (APP review 2): the uninstall purge runs inside the uninstall section, after the TA confirmed and
// after the "app is running" check, and only on a real uninstall; placeholder turns are not content; the temp
// PCM is 16-bit; a start during the headless sweep is handed over, not lost.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { floatToInt16, makeOpenPcm, pcmPaths } from "../../src/main/pcmFiles";
import { SweepHandover } from "../../src/main/sweepHandover";
import { hasContent, UNCLEAR_SEGMENT_TEXT } from "../../src/core/transcript";
import type { Job } from "../../src/core";

const ROOT = join(__dirname, "..", "..");

/** The body of one NSIS macro in a file, or null. */
function macro(nsh: string, name: string): string | null {
  const start = nsh.indexOf(`!macro ${name}`);
  if (start < 0) return null;
  const end = nsh.indexOf("!macroend", start);
  // Expand the file's own helper macros, so the checks see what NSIS will actually run, in order.
  return nsh.slice(start, end).replace(/!insertmacro (ta\w+)/g, (_m, inner: string) => macro(nsh, inner) ?? "");
}

describe("I-R1: the purge runs inside the uninstall section, after confirmation and the app-running check", () => {
  it("is not in customUnInit (un.onInit runs before the Welcome page and its Cancel button)", async () => {
    const nsh = await readFile(join(ROOT, "build", "installer.nsh"), "utf8");
    expect(macro(nsh, "customUnInit")).toBeNull();
    expect(nsh).not.toMatch(/un\.onInit/);
  });

  it("is in customRemoveFiles, guarded so an update never purges, and keeps electron-builder's own removal", async () => {
    const nsh = await readFile(join(ROOT, "build", "installer.nsh"), "utf8");
    const body = macro(nsh, "customRemoveFiles");
    expect(body).not.toBeNull();
    const purgeAt = body!.indexOf("--uninstall-purge");
    expect(purgeAt).toBeGreaterThan(0);
    // An update runs the old uninstaller with "/S /KEEP_APP_DATA" and "--updated" or "--delete-app-data":
    // both markers are checked before the purge (m-R3).
    expect(body!.indexOf('"--updated"')).toBeGreaterThan(-1);
    expect(body!.indexOf('"--updated"')).toBeLessThan(purgeAt);
    expect(body!.indexOf('"/KEEP_APP_DATA"')).toBeGreaterThan(-1);
    expect(body!.indexOf('"/KEEP_APP_DATA"')).toBeLessThan(purgeAt);
    expect(body!.slice(0, purgeAt)).toMatch(/\$\{If\} \$R2 == "purge"/);
    // Then electron-builder's default body, unchanged: the update rename branch and RMDir.
    const rest = body!.slice(purgeAt);
    expect(rest).toContain("${if} ${isUpdated}");
    expect(rest).toContain("Call un.atomicRMDir");
    expect(rest).toContain("RMDir /r $INSTDIR");
  });

  it("electron-builder inserts customRemoveFiles after the app-running check, inside Section un.install", async () => {
    const tpl = await readFile(join(ROOT, "node_modules", "app-builder-lib", "templates", "nsis", "uninstaller.nsh"), "utf8");
    const section = tpl.indexOf('Section "un.install"');
    const check = tpl.indexOf("call un.checkAppRunning", section);
    const removeFiles = tpl.indexOf("!insertmacro customRemoveFiles", section);
    expect(section).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(section);
    expect(removeFiles).toBeGreaterThan(check);
  });

  it("the task is removed on a real uninstall only, with the same guard", async () => {
    const nsh = await readFile(join(ROOT, "build", "installer.nsh"), "utf8");
    const body = macro(nsh, "customUnInstall")!;
    expect(body).toContain('"--updated"');
    expect(body).toContain('"/KEEP_APP_DATA"');
    expect(body).toContain('schtasks.exe /Delete /TN "TA Call Recorder cleanup" /F');
  });
});

describe("m-R1: the unclear-segment placeholder is not content", () => {
  it("a call whose only candidate turn is the placeholder has no content", () => {
    expect(hasContent([{ speaker: "candidate", start_ms: 0, end_ms: 1000, text: UNCLEAR_SEGMENT_TEXT }])).toBe(false);
    expect(hasContent([
      { speaker: "ta", start_ms: 0, end_ms: 1000, text: "Chào bạn" },
      { speaker: "candidate", start_ms: 1000, end_ms: 2000, text: UNCLEAR_SEGMENT_TEXT },
    ])).toBe(false);
    expect(hasContent([{ speaker: "candidate", start_ms: 0, end_ms: 1000, text: "Dạ em chào chị" }])).toBe(true);
  });
});

describe("m-R4: the temp PCM is 16-bit (half the disk)", () => {
  let folder: string;
  const ID = "cmh2x9k0a0001qz8v7y6t5r4e";
  beforeEach(async () => {
    folder = join(await mkdtemp(join(tmpdir(), "tacr-fix3-")), ID);
    await mkdir(folder, { recursive: true });
  });
  afterEach(async () => {
    await rm(join(folder, ".."), { recursive: true, force: true });
  });

  it("converts float samples to 16-bit, clamped", () => {
    expect([...floatToInt16(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]))]).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768]);
  });

  it("stores 2 bytes per sample and reads them back as floats", async () => {
    await writeFile(join(folder, `${ID}.left.webm`), "L");
    await writeFile(join(folder, `${ID}.right.webm`), "R");
    const samples = new Float32Array([0, 0.25, -0.25, 0.5]);
    const open = makeOpenPcm(async (_webm, file) => {
      await writeFile(file, Buffer.from(floatToInt16(samples).buffer));
    });
    const src = await open({ id: ID, folder } as Job);
    expect((await stat(pcmPaths(folder, ID).left)).size).toBe(samples.length * 2);
    expect(src!.left.length).toBe(4);
    const back = await src!.left.read(1, 3);
    expect([...back].map((v) => Math.round(v * 1000) / 1000)).toEqual([0.25, -0.25, 0.5]);
    await src!.close?.();
  });
});

describe("m-R5: a start or Solace link during the headless sweep is handed over", () => {
  it("remembers the last request and relaunches with its arguments after the sweep", () => {
    const h = new SweepHandover();
    expect(h.relaunchArgs()).toBeNull();
    h.noteRequest(["C:\\Program Files\\TA Call Recorder\\TA Call Recorder.exe"]);
    expect(h.relaunchArgs()).toEqual([]);
    const link = "tacallrecorder://start?session_id=cmh2x9k0a0001qz8v7y6t5r4e&ticket=" + "L".repeat(43) + "&dial_mode=3cx";
    h.noteRequest(["C:\\app.exe", link]);
    expect(h.relaunchArgs()).toEqual([link]);
  });

  it("never relaunches another sweep or purge, and keeps the dev app path", () => {
    const h = new SweepHandover();
    h.noteRequest(["C:\\app.exe", "--sweep"]);
    expect(h.relaunchArgs()).toBeNull();
    h.noteRequest(["C:\\app.exe", "--uninstall-purge"]);
    expect(h.relaunchArgs()).toBeNull();
    h.noteRequest(["C:\\node_modules\\electron\\dist\\electron.exe", "C:\\dev\\app", "--dev"]);
    expect(h.relaunchArgs()).toEqual(["C:\\dev\\app", "--dev"]);
  });
});
