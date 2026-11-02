// UX pass 02/11/2026 (UX-APP): copy, states and accessibility of the recorder window and the floating bar.
// UI only: none of these change what is recorded, sent or kept.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callRows } from "../../src/main/callsView";
import { clockWarning } from "../../src/main/deepLinkFlow";
import { NO_KEY_DETAIL } from "../../src/main/ipcTypes";
import { folderBanner, isStaleNoticeMessage, startHint, startIsPrimary } from "../../src/renderer/recorderCopy";
import type { Job } from "../../src/core";

const ROOT = join(__dirname, "..", "..");
const read = (...p: string[]) => readFile(join(ROOT, ...p), "utf8");

/** WCAG relative luminance contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const cssVar = (css: string, name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css)?.[1] ?? "";

describe("the hint under Start says what to do next", () => {
  it("with Test mode off, points to Solace's buttons by their Solace names", () => {
    const t = startHint(false, "Ctrl+Alt+R");
    expect(t).toContain('"Call & record"');
    expect(t).toContain(`"Record only, I'll call myself"`);
    expect(t).toMatch(/starts recording by itself/);
  });

  it("with Test mode on, says Start and the shortcut record a Local only call, never sent", () => {
    const t = startHint(true, "Ctrl+Alt+R");
    expect(t).toMatch(/^Test mode is on/);
    expect(t).toContain("Ctrl+Alt+R");
    expect(t).toMatch(/"Local only"/);
    expect(t).toMatch(/never sent to Solace/);
  });

  it("Start is the main (blue) button only in Test mode: without it, Solace is where a call starts", () => {
    expect(startIsPrimary(true)).toBe(true);
    expect(startIsPrimary(false)).toBe(false);
  });
});

describe("messages that no longer apply go away", () => {
  it("'accept the notice first' is stale once the notice is accepted", () => {
    const text = "Open Set-up check and accept the notice first.";
    expect(isStaleNoticeMessage(text, true)).toBe(true);
    expect(isStaleNoticeMessage(text, false)).toBe(false);
    expect(isStaleNoticeMessage("Saved call x.", true)).toBe(false);
  });
});

describe("a recordings-folder problem is shown next to Start, with the next step", () => {
  it("says recording is off and where to fix it", () => {
    const t = folderBanner("This folder is inside OneDrive, which would copy call recordings to the cloud. Choose a folder outside OneDrive.");
    expect(t).toMatch(/^Recording is off\./);
    expect(t).toContain("inside OneDrive");
    expect(t).toMatch(/Settings → Recordings folder → Change…/);
    expect(folderBanner(null)).toBeNull();
  });

  it("the window has the banner and an Open Settings button for it", async () => {
    const html = await read("src", "renderer", "static", "recorder.html");
    expect(html).toMatch(/id="dir-problem-main"[^>]*role="alert"/);
    expect(html).toContain('id="btn-dir-settings"');
    expect(html).toContain('id="btn-key-settings"');
  });
});

describe("the no-key line reads the same everywhere", () => {
  it("ends with a full stop, in the row and in the banner", async () => {
    expect(NO_KEY_DETAIL).toBe("Add a Gemini key in Settings to transcribe.");
    const job = { id: "20261102-100000-aaaaaa", folder: "x", sessionId: null, startedAt: "2026-11-02T10:00:00+07:00", endedAt: "2026-11-02T10:01:00+07:00", stage: "recorded", attempts: 0, nextAttemptAt: null, callId: null, duplicate: false, failure: null, createdAt: "", updatedAt: "" } as unknown as Job;
    expect(callRows([job], { hasKey: false, transcriptIds: new Set() })[0].detail).toBe(NO_KEY_DETAIL);
    const html = await read("src", "renderer", "static", "recorder.html");
    expect(html).toContain(NO_KEY_DETAIL);
  });
});

describe("the clock warning says how to fix it", () => {
  it("names the Windows setting, in a full sentence", () => {
    const now = Date.parse("2026-10-29T03:00:00Z");
    expect(clockWarning("2026-10-29T03:05:00Z", now)).toBe(
      "Your laptop clock is off by 5 min, so Solace may reject the call. Fix it in Windows Settings → Time & language → Date & time → Sync now.",
    );
  });
});

describe("accessibility of the recorder window", () => {
  it("announces the status, the set-up check results and messages", async () => {
    const html = await read("src", "renderer", "static", "recorder.html");
    expect(html).toMatch(/id="status"[^>]*aria-live="polite"/);
    for (const n of [1, 2, 3, 4, 5]) expect(html).toMatch(new RegExp(`id="wz-status-${n}"[^>]*role="status"`));
  });

  it("the set-up check marks the current step, closes with Escape (= Later) and takes the focus when it opens", async () => {
    const src = await read("src", "renderer", "wizard.ts");
    expect(src).toContain('"aria-current"');
    expect(src).toMatch(/key === "Escape"/);
    expect(src).toMatch(/\.focus\(/);
  });

  it("text colours meet WCAG AA (4.5:1) on their backgrounds", async () => {
    const css = await read("src", "renderer", "static", "recorder.css");
    const dangerText = cssVar(css, "--danger-text");
    expect(contrast(dangerText, cssVar(css, "--error-bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dangerText, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", cssVar(css, "--amber"))).toBeGreaterThanOrEqual(4.5);
    expect(css).toMatch(/\.message\.error\s*\{[^}]*color:\s*var\(--danger-text\)/);
    expect(css).toMatch(/\.test-badge\s*\{[^}]*background:\s*var\(--amber\)/);
    expect(css).toMatch(/:focus-visible/);
  });
});

describe("the floating bar", () => {
  it("names its icon-only parts for screen readers", async () => {
    const bar = await read("src", "renderer", "static", "bar.html");
    expect(bar).toMatch(/id="btn-open"[^>]*aria-label="Open the recorder"/);
    expect(bar).toMatch(/id="warn"[^>]*aria-label="[^"]+"/);
    expect(bar).toMatch(/id="timer"[^>]*role="timer"/);
  });

  it("is wide enough for the TEST badge, the warning and all three buttons", async () => {
    const win = await read("src", "main", "windows.ts");
    const width = Number(/BAR_WIDTH = (\d+)/.exec(win)?.[1]);
    expect(width).toBeGreaterThanOrEqual(380);
    const css = await read("src", "renderer", "static", "bar.css");
    expect(contrast("#ffffff", /\.test-badge\s*\{[^}]*background:\s*(#[0-9a-f]{6})/i.exec(css)?.[1] ?? "")).toBeGreaterThanOrEqual(4.5);
  });
});
