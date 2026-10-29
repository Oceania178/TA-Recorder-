// The tray icon (grey idle, red recording, amber paused) and its menu: Start / Pause / Stop / Open / Settings / Quit.
import { Menu, nativeImage, Tray } from "electron";
import type { RecorderState } from "./ipcTypes";
import { SHORTCUTS } from "./shortcuts";
import { dotBitmap, trayColourFor } from "./trayIcon";

export interface TrayActions {
  start(): void;
  pauseOrResume(): void;
  stop(): void;
  open(): void;
  settings(): void;
  quit(): void;
}

function iconFor(state: RecorderState): Electron.NativeImage {
  const colour = trayColourFor(state);
  const image = nativeImage.createFromBitmap(dotBitmap(16, colour), { width: 16, height: 16, scaleFactor: 1 });
  image.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: dotBitmap(32, colour) });
  return image;
}

const TOOLTIP: Record<RecorderState, string> = {
  idle: "TA Call Recorder — ready",
  starting: "TA Call Recorder — starting…",
  recording: "TA Call Recorder — recording",
  paused: "TA Call Recorder — paused",
  stopping: "TA Call Recorder — saving…",
};

export class RecorderTray {
  private readonly tray: Tray;

  constructor(private readonly actions: TrayActions) {
    this.tray = new Tray(iconFor("idle"));
    this.tray.on("click", () => actions.open());
    this.update("idle");
  }

  update(state: RecorderState): void {
    this.tray.setImage(iconFor(state));
    this.tray.setToolTip(TOOLTIP[state]);
    const active = state === "recording" || state === "paused";
    const menu = Menu.buildFromTemplate([
      { label: `Start recording (${SHORTCUTS.toggleRecord.label})`, enabled: state === "idle", click: () => this.actions.start() },
      { label: `${state === "paused" ? "Resume" : "Pause"} (${SHORTCUTS.togglePause.label})`, enabled: active, click: () => this.actions.pauseOrResume() },
      { label: `Stop and save (${SHORTCUTS.toggleRecord.label})`, enabled: active, click: () => this.actions.stop() },
      { type: "separator" },
      { label: "Open recorder", click: () => this.actions.open() },
      { label: "Settings", click: () => this.actions.settings() },
      { type: "separator" },
      { label: "Quit", click: () => this.actions.quit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  notifyOnce(title: string, content: string): void {
    this.tray.displayBalloon({ title, content, iconType: "info" });
  }

  destroy(): void {
    this.tray.destroy();
  }
}
