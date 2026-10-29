import { describe, expect, it } from "vitest";
import { SessionGuard } from "../../src/main/sessionGuard";
import { commandForShortcut, SHORTCUTS } from "../../src/main/shortcuts";

describe("SessionGuard (one recording at a time, D-39)", () => {
  it("lets the first start through and refuses a second with a clear message", () => {
    const g = new SessionGuard();
    expect(g.state).toBe("idle");
    expect(g.tryBegin()).toEqual({ ok: true });
    expect(g.state).toBe("starting");
    const second = g.tryBegin();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toMatch(/already recording/i);
  });

  it("follows a whole call: start, pause, resume, stop", () => {
    const g = new SessionGuard();
    g.tryBegin();
    g.started("ID1234");
    expect(g.state).toBe("recording");
    expect(g.activeCallId).toBe("ID1234");
    expect(g.tryBegin().ok).toBe(false);
    g.paused();
    expect(g.state).toBe("paused");
    expect(g.tryBegin().ok).toBe(false);
    g.resumed();
    expect(g.state).toBe("recording");
    g.stopping();
    expect(g.state).toBe("stopping");
    expect(g.tryBegin().ok).toBe(false);
    g.ended();
    expect(g.state).toBe("idle");
    expect(g.activeCallId).toBeNull();
    expect(g.tryBegin().ok).toBe(true);
  });

  it("goes back to idle when a start fails", () => {
    const g = new SessionGuard();
    g.tryBegin();
    g.ended();
    expect(g.state).toBe("idle");
  });

  it("ignores pause when not recording", () => {
    const g = new SessionGuard();
    g.paused();
    expect(g.state).toBe("idle");
  });
});

describe("global shortcuts", () => {
  it("uses Ctrl+Alt+R for start/stop and Ctrl+Alt+P for pause/resume", () => {
    expect(SHORTCUTS.toggleRecord).toEqual({ accelerator: "Control+Alt+R", label: "Ctrl+Alt+R" });
    expect(SHORTCUTS.togglePause).toEqual({ accelerator: "Control+Alt+P", label: "Ctrl+Alt+P" });
  });

  it("maps each shortcut to the right command for the current state", () => {
    expect(commandForShortcut("toggleRecord", "idle")).toBe("start");
    expect(commandForShortcut("toggleRecord", "recording")).toBe("stop");
    expect(commandForShortcut("toggleRecord", "paused")).toBe("stop");
    expect(commandForShortcut("toggleRecord", "starting")).toBeNull();
    expect(commandForShortcut("toggleRecord", "stopping")).toBeNull();
    expect(commandForShortcut("togglePause", "recording")).toBe("pause");
    expect(commandForShortcut("togglePause", "paused")).toBe("resume");
    expect(commandForShortcut("togglePause", "idle")).toBeNull();
  });
});
