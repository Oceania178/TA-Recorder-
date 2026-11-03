// D-171: what the TA sees for "Import a recording" — the button, the import dialog with its limits, the
// "Which voice is yours?" dialog, the bar's Import button, and the main wiring that keeps the import safe.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importButton, importDone, speakerSendLabel } from "../../src/renderer/importText";
import { startHint } from "../../src/renderer/recorderCopy";

const ROOT = join(__dirname, "..", "..");
const read = (...p: string[]) => readFile(join(ROOT, ...p), "utf8");

describe("the Import button", () => {
  it("idle: shown only in Test mode (without Solace an import is Local only); during a Solace call: 'instead'", () => {
    expect(importButton("idle", null, false)).toEqual({ visible: false, label: "Import a recording…", enabled: true });
    expect(importButton("idle", null, true)).toEqual({ visible: true, label: "Import a recording…", enabled: true });
    expect(importButton("recording", true, false)).toEqual({ visible: true, label: "Import a recording instead…", enabled: true });
    expect(importButton("paused", true, false)).toEqual({ visible: true, label: "Import a recording instead…", enabled: true });
    expect(importButton("recording", false, true)).toMatchObject({ visible: false });
    expect(importButton("starting", true, false)).toMatchObject({ enabled: false });
  });

  it("the hint under Start says how to import with Test mode off", () => {
    expect(startHint(false, "Ctrl+Alt+R")).toContain('"Import a recording instead…"');
  });
});

describe("words after an import, and the send button of the voice choice", () => {
  it("stereo vs mono, Solace vs Local only", () => {
    expect(importDone({ audio: "stereo", fromFileTime: true }, true)).toBe("Imported. It is transcribed next and sent to Solace — see Recent calls.");
    expect(importDone({ audio: "mono", fromFileTime: true }, true)).toBe("Imported. Gemini now tells the two voices apart; then choose which one is yours, and it is sent to Solace.");
    expect(importDone({ audio: "stereo", fromFileTime: false }, false)).toBe("Imported (Local only — never sent). It is transcribed next — see Recent calls. The file's own time could not be used, so the import time is the call's time.");
    expect(speakerSendLabel(true)).toBe("Send to Solace");
    expect(speakerSendLabel(false)).toBe("Save the transcript");
  });
});

describe("the window", () => {
  it("has the Import button, the import dialog with its limits, and the voice dialog", async () => {
    const html = await read("src", "renderer", "static", "recorder.html");
    expect(html).toContain('id="btn-import"');
    expect(html).toMatch(/id="import-dialog"[^>]*hidden/);
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="import-title"/);
    expect(html).toContain("MP3, M4A, WAV, WebM or OGG");
    expect(html).toContain("up to 2 hours (250 MB)");
    expect(html).toContain("deleted after 3 days");
    expect(html).toContain('id="import-mixed"');
    expect(html).toMatch(/id="import-status"[^>]*role="status"/);
    expect(html).toMatch(/id="import-live-warning"[^>]*hidden/);
    expect(html).toMatch(/id="speakers-dialog"[^>]*hidden/);
    expect(html).toContain("Which voice is yours?");
    expect(html).toMatch(/name="speaker-me" value="A"/);
    expect(html).toMatch(/id="speakers-status"[^>]*role="status"/);
  });

  it("Recent calls: 'Choose your voice' on a waiting mono import, 'Imported' in the line", async () => {
    const src = await read("src", "renderer", "recentCalls.ts");
    expect(src).toContain('"Choose your voice"');
    expect(src).toContain("Imported");
  });

  it("the bar has an Import button for a live Solace call", async () => {
    const bar = await read("src", "renderer", "static", "bar.html");
    expect(bar).toMatch(/id="btn-import"[^>]*hidden[^>]*>Import</);
    const ts = await read("src", "renderer", "bar.ts");
    expect(ts).toContain('sendBarCommand("import")');
  });
});

describe("main keeps the import safe", () => {
  it("the page never gets a path; no recording while importing; the live Solace recording is replaced, not kept", async () => {
    const main = await read("src", "main", "main.ts");
    expect(main).toContain("importPicks.set(token, file)");
    expect(main).toMatch(/isRecording: \(\) => c\.guard\.isActive \|\| importing/);
    expect(main).toMatch(/if \(importing\) return \{ ok: false, message: IMPORT_MESSAGES\.busy \}/);
    expect(main).toContain("c.takeLiveSessionForImport(callId)");
    expect(main).toContain("E2E?.importFile");
  });
});
