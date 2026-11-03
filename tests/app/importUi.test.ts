// D-171: what the TA sees for "Import a recording" — the button, the import dialog with its limits, the
// "Which voice is yours?" dialog, the bar's Import button, and the main wiring that keeps the import safe.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importButton, importDone, layoutHint, speakerSendLabel } from "../../src/renderer/importText";
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
    // review R3 I3: every two-channel file asks how it is laid out
    expect(html).not.toContain('id="import-mixed"');
    expect(html).toContain("Is this a TA Call Recorder stereo file (you on the left, the candidate on the right)?");
    expect(html).toMatch(/name="import-layout" value="left-ta"[^>]*\/> Yes</);
    expect(html).toMatch(/name="import-layout" value="mixed"[^>]*\/> No, both voices are mixed</);
    expect(html).toMatch(/name="import-layout" value="right-ta"[^>]*\/> Yes, but I'm on the right</);
    expect(html).toContain('id="import-run"');
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

describe("the layout hint and the voice dialog's warnings", () => {
  it("the hint names this app's file names; otherwise it says what 'mixed' does", () => {
    expect(layoutHint(true)).toBe("The file name looks like a TA Call Recorder recording.");
    expect(layoutHint(false)).toBe('Not sure? Choose "No, both voices are mixed": Gemini then tells the two voices apart, and you check them before anything is sent.');
  });

  it("a doubtful part says 'Check this part'; a refused part says it could not be transcribed; Esc / Cancel end the attempt", async () => {
    const src = await read("src", "renderer", "importUi.ts");
    expect(src).toContain('"Check this part: the letters may be the other way round."');
    expect(src).toContain('"This part could not be transcribed. It shows as [không nghe rõ] in the transcript."');
    expect(src).toContain("api().cancelImport()");
  });
});
