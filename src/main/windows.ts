// The recorder window (closing it hides it to the tray) and the small always-on-top bar shown while recording.
import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import type { Command } from "./ipcTypes";

const BAR_WIDTH = 340;
const BAR_HEIGHT = 52;

function webPreferences(preload: string): Electron.WebPreferences {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // Keep timers and recorders running at full speed while the window is hidden in the tray.
    backgroundThrottling: false,
    // Shortcuts and the tray start recording without a click in the page.
    autoplayPolicy: "no-user-gesture-required",
    spellcheck: false,
  };
}

export function createRecorderWindow(rendererDir: string, preload: string, show: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 420,
    minHeight: 520,
    show: false,
    title: "TA Call Recorder",
    autoHideMenuBar: true,
    webPreferences: webPreferences(preload),
  });
  win.removeMenu();
  void win.loadFile(join(rendererDir, "recorder.html"));
  if (show) win.once("ready-to-show", () => win.show());
  return win;
}

/** The bar gets its own minimal preload (barPreload.ts): status in, three buttons out. */
export function createBarWindow(rendererDir: string, preload: string): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea;
  const bar = new BrowserWindow({
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    x: Math.round(area.x + (area.width - BAR_WIDTH) / 2),
    y: area.y + 8,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    title: "TA Call Recorder bar",
    webPreferences: webPreferences(preload),
  });
  bar.setAlwaysOnTop(true, "floating");
  void bar.loadFile(join(rendererDir, "bar.html"));
  return bar;
}

/**
 * Runs a recorder command inside the recorder page as if the user clicked: getDisplayMedia (system audio)
 * needs a user gesture, and commands from the tray or a shortcut have none. Only fixed command names go in.
 */
export function sendCommandToRecorder(win: BrowserWindow, command: Command | "settings"): void {
  const allowed: readonly string[] = ["start", "startLinked", "stop", "pause", "resume", "settings"];
  if (!allowed.includes(command)) return;
  if (win.isDestroyed()) return;
  const name = JSON.stringify(command);
  void win.webContents.executeJavaScript(`window.__taRecorderCommand && window.__taRecorderCommand(${name})`, true).catch(() => undefined);
}
