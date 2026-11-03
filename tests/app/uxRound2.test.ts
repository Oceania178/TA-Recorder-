// UX round 2 (Triet approved 02/11/2026): P1 compact "in call" layout, P2 a Solace start leaves Solace in front,
// P3 the floating bar shows Solace / Local only and follows the call after Stop, P11 a notification when a call is
// Sent or Failed, P4 the last call in the tray menu. UI only: capture, queue, sending and retention are unchanged.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CallRow } from "../../src/main/callsView";
import { followView } from "../../src/main/barFollow";
import { callTime, OutcomeWatcher } from "../../src/main/callOutcomes";
import { NO_KEY_DETAIL } from "../../src/main/ipcTypes";
import { LinkStartWindow } from "../../src/main/linkWindow";
import { lastCall, trayMenuItems } from "../../src/main/trayMenu";
import { barChip } from "../../src/renderer/barText";
import { isInCall } from "../../src/renderer/inCall";
import { showLater } from "../../src/main/showLater";

const ROOT = join(__dirname, "..", "..");
const read = (...p: string[]) => readFile(join(ROOT, ...p), "utf8");

function row(over: Partial<CallRow> = {}): CallRow {
  return { id: "sess-0001-aaaa", startedAt: "2026-11-02T14:05:00+07:00", durationS: 300, linked: true, stage: "Recorded", detail: null, canRetry: false, hasTranscript: false, needsSpeakers: false, imported: false, ...over };
}
const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

describe("P1: a compact layout while a call is recorded", () => {
  it("is on while recording, paused or saving; off when idle or starting", () => {
    expect(isInCall("recording")).toBe(true);
    expect(isInCall("paused")).toBe(true);
    expect(isInCall("stopping")).toBe(true);
    expect(isInCall("idle")).toBe(false);
    expect(isInCall("starting")).toBe(false);
  });

  it("folds Recent calls, Device check and Settings, never the recorder card", async () => {
    const html = await read("src", "renderer", "static", "recorder.html");
    for (const id of ["calls", "devices", "settings"]) expect(html).toMatch(new RegExp(`<section class="card fold-in-call" id="${id}"`));
    expect(html).not.toMatch(/class="card recorder[^"]*fold-in-call/);
    const css = await read("src", "renderer", "static", "recorder.css");
    expect(css).toMatch(/body\.in-call \.fold-in-call:not\(\.has-warning\)\s*\{\s*display:\s*none/);
    const src = await read("src", "renderer", "recorder.ts");
    expect(src).toContain('classList.toggle("in-call", isInCall(next))');
    expect(src).toContain('classList.toggle("has-warning"');
  });
});

describe("P2: a Solace start leaves Solace in front", () => {
  it("hides the window once the linked recording runs", () => {
    const w = new LinkStartWindow();
    w.linkStarted();
    expect(w.status("idle")).toBeNull(); // the page has not pressed Start yet
    expect(w.status("starting")).toBeNull();
    expect(w.status("recording")).toBe("hide");
    expect(w.status("recording")).toBeNull(); // once
  });

  it("shows the window when the linked start fails or never happens", () => {
    const w = new LinkStartWindow();
    w.linkStarted();
    w.status("starting");
    expect(w.status("idle")).toBe("show");
    const late = new LinkStartWindow();
    late.linkStarted();
    expect(late.timedOut()).toBe("show");
    expect(late.status("recording")).toBeNull();
  });

  it("does nothing for a local start", () => {
    const w = new LinkStartWindow();
    expect(w.status("starting")).toBeNull();
    expect(w.status("recording")).toBeNull();
    expect(w.timedOut()).toBeNull();
  });

  it("main no longer brings the window forward for a linked start, and shows it for a refusal", async () => {
    const main = await read("src", "main", "main.ts");
    const start = main.slice(main.indexOf("start: (session) =>"), main.indexOf("log: (e, f) => log.event(e, f),\n  });\n  setDeepLinkHandler"));
    expect(start).not.toMatch(/armLinkedCall\(session\);\s*showRecorder\(\);/);
    expect(start).toContain("linkWindow.linkStarted()");
    expect(start).toMatch(/if \(linkWindow\.timedOut\(\) === "show"\) showRecorder\(\);/);
    expect(main).toMatch(/if \(!outcome\.ok\) showRecorder\(\);/);
  });
});

describe("P3: the floating bar", () => {
  it("shows Solace or Local only for the call being recorded", () => {
    expect(barChip(true)).toEqual({ text: "Solace", kind: "linked" });
    expect(barChip(false)).toEqual({ text: "Local only", kind: "local" });
    expect(barChip(null)).toBeNull();
  });

  it("follows the call after Stop: each stage in plain words", () => {
    const t = hhmm("2026-11-02T14:05:00+07:00");
    expect(followView(row({ stage: "Recorded" }))).toMatchObject({ title: `Call of ${t}`, text: "Saved, transcribing next", final: false, canRetry: false, linked: true });
    expect(followView(row({ stage: "Recorded", detail: NO_KEY_DETAIL })).text).toBe("Waiting for a Gemini key (Settings)");
    expect(followView(row({ stage: "Transcribing" })).text).toBe("Transcribing…");
    expect(followView(row({ stage: "Transcribed" })).text).toBe("Transcribed, sending next");
    expect(followView(row({ stage: "Transcribed", detail: "Waiting to try again (network or service busy). Nothing to do: it goes on by itself." })).text).toBe("Waiting to send (network busy)");
    expect(followView(row({ stage: "Sending" })).text).toBe("Sending to Solace…");
    expect(followView(row({ stage: "Sent" }))).toMatchObject({ text: "Sent to Solace", final: true });
    expect(followView(row({ stage: "Failed", canRetry: true }))).toMatchObject({ text: "Failed — open the recorder to see why", canRetry: true, final: false });
    expect(followView(row({ stage: "Transcribed", linked: false, detail: "Local only — not linked to Solace" }))).toMatchObject({ text: "Transcribed (Local only)", final: true, linked: false });
  });

  it("before the call is queued it says Saved", () => {
    expect(followView(undefined)).toMatchObject({ title: "Call", text: "Saved", final: false, canRetry: false });
  });

  it("the bar has the Solace / Local chip and Retry and Close for the follow-up", async () => {
    const bar = await read("src", "renderer", "static", "bar.html");
    expect(bar).toContain('id="call-chip"');
    expect(bar).toMatch(/id="btn-retry"[^>]*>Retry</);
    expect(bar).toMatch(/id="btn-close"[^>]*aria-label="Close the bar"/);
    expect(bar).toMatch(/id="follow-text"[^>]*role="status"/);
    const preload = await read("src", "main", "barPreload.ts");
    expect(preload).toContain('"retry"');
    expect(preload).toContain('"close"');
  });
});

describe("P11: a notification when a call is Sent or Failed", () => {
  it("callTime is the laptop's hh:mm", () => {
    expect(callTime("2026-11-02T14:05:00+07:00")).toBe(hhmm("2026-11-02T14:05:00+07:00"));
  });

  it("says nothing about calls that were already Sent or Failed at start-up", () => {
    const w = new OutcomeWatcher();
    expect(w.update([row({ stage: "Sent" }), row({ id: "sess-0002-bbbb", stage: "Failed" })])).toEqual([]);
  });

  it("one notification per call per outcome, with no name, path, ticket or transcript", () => {
    const w = new OutcomeWatcher();
    const t = hhmm("2026-11-02T14:05:00+07:00");
    w.update([row({ stage: "Sending" })]);
    expect(w.update([row({ stage: "Sent" })])).toEqual([{ id: "sess-0001-aaaa", outcome: "sent", title: "TA Call Recorder", body: `Call of ${t} sent to Solace.` }]);
    expect(w.update([row({ stage: "Sent" })])).toEqual([]);
    const f = new OutcomeWatcher();
    f.update([row({ stage: "Sending" })]);
    expect(f.update([row({ stage: "Failed" })])).toEqual([{ id: "sess-0001-aaaa", outcome: "failed", title: "TA Call Recorder", body: `Call of ${t} could not be sent to Solace. Open TA Call Recorder to see why.` }]);
    f.update([row({ stage: "Transcribed" })]); // Retry
    expect(f.update([row({ stage: "Failed" })])).toEqual([]); // same outcome again: quiet
  });

  it("stays quiet for Local only calls", () => {
    const w = new OutcomeWatcher();
    w.update([row({ linked: false, stage: "Transcribing" })]);
    expect(w.update([row({ linked: false, stage: "Transcribed", detail: "Local only — not linked to Solace" })])).toEqual([]);
    expect(w.update([row({ linked: false, stage: "Failed" })])).toEqual([]);
  });

  it("a call that first appears already Sent (after start-up) is announced", () => {
    const w = new OutcomeWatcher();
    w.update([]);
    expect(w.update([row({ stage: "Sent" })])).toHaveLength(1);
  });
});

describe("P4: the last call in the tray menu", () => {
  it("names the newest call's stage and the newest transcript", () => {
    const t = hhmm("2026-11-02T14:05:00+07:00");
    const rows = [row({ stage: "Sending" }), row({ id: "older-0002", startedAt: "2026-11-02T13:00:00+07:00", stage: "Sent", hasTranscript: true })];
    expect(lastCall(rows)).toEqual({ line: `Last call (${t}): Sending`, transcriptId: "older-0002" });
    expect(lastCall([row({ linked: false, stage: "Transcribed", detail: "Local only — not linked to Solace", hasTranscript: true })])).toEqual({ line: `Last call (${t}): Transcribed, Local only`, transcriptId: "sess-0001-aaaa" });
    expect(lastCall([])).toEqual({ line: "No calls yet", transcriptId: null });
  });

  it("the menu has the line (disabled) and Open last transcript; no Test mode switch", () => {
    const items = trayMenuItems("idle", { line: "Last call (14:05): Sent", transcriptId: null });
    const labels = items.map((i) => ("label" in i ? i.label : "---"));
    expect(labels).toContain("Last call (14:05): Sent");
    expect(items.find((i) => "label" in i && i.label === "Last call (14:05): Sent")).toMatchObject({ enabled: false });
    expect(items.find((i) => "label" in i && i.label === "Open last transcript")).toMatchObject({ enabled: false, action: "openLastTranscript" });
    expect(trayMenuItems("idle", { line: "x", transcriptId: "abc" }).find((i) => "label" in i && i.label === "Open last transcript")).toMatchObject({ enabled: true });
    expect(labels.some((l) => /test mode/i.test(l))).toBe(false);
    expect(labels).toEqual(expect.arrayContaining(["Start recording (Ctrl+Alt+R)", "Pause (Ctrl+Alt+P)", "Stop and save (Ctrl+Alt+R)", "Open recorder", "Settings", "Set-up check…", "Quit"]));
  });
});

describe("Windows notifications never show inside the second-instance task", () => {
  // Found in UX round 2: with Electron 33 on Windows, showing a notification while the app handles a second
  // instance (a Solace link refused at once) crashes the app if any notification was shown before. Deferring
  // the show to the next task avoids it (proved with a probe against the dev build).
  it("showLater schedules the show for later, never runs it at once", () => {
    const calls: string[] = [];
    let scheduled: { fn: () => void; ms: number } | null = null;
    showLater(() => calls.push("shown"), (fn, ms) => (scheduled = { fn, ms }));
    expect(calls).toEqual([]);
    expect(scheduled!.ms).toBeGreaterThan(0);
    scheduled!.fn();
    expect(calls).toEqual(["shown"]);
  });

  it("main never calls a notification's show() directly", async () => {
    const main = await read("src", "main", "main.ts");
    expect(main).not.toMatch(/new Notification\([^)]*\)\.show\(\)/);
    expect(main).not.toMatch(/^\s*n\.show\(\);/m);
    expect(main).toMatch(/showLater\(/);
  });
});
