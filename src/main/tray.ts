// The tray icon (grey idle, red recording, amber paused) and its menu (trayMenu.ts): Start / Pause / Stop, the last
// call's stage and "Open last transcript" (UX round 2, P4), Open / Settings / Set-up check / Quit.
import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";
import type { RecorderState } from "./ipcTypes";
import { dotBitmap, trayColourFor, trayTooltip } from "./trayIcon";
import { trayMenuItems, type LastCall, type TrayAction } from "./trayMenu";

export type TrayActions = Record<TrayAction, () => void>;

function iconFor(state: RecorderState): Electron.NativeImage {
  const colour = trayColourFor(state);
  const image = nativeImage.createFromBitmap(dotBitmap(16, colour), { width: 16, height: 16, scaleFactor: 1 });
  image.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: dotBitmap(32, colour) });
  return image;
}

export class RecorderTray {
  private readonly tray: Tray;
  private state: RecorderState = "idle";
  private testMode = false;
  private last: LastCall = { line: "No calls yet", transcriptId: null };

  constructor(private readonly actions: TrayActions) {
    this.tray = new Tray(iconFor("idle"));
    this.tray.on("click", () => actions.open());
    this.update("idle");
  }

  /** D-165: show "TEST MODE" in the tooltip while Test mode is on. */
  setTestMode(on: boolean): void {
    this.testMode = on;
    this.tray.setToolTip(trayTooltip(this.state, this.testMode));
  }

  /** P4: the newest call's stage line and the newest transcript (rebuilt when Recent calls changes). */
  setLastCall(last: LastCall): void {
    if (last.line === this.last.line && last.transcriptId === this.last.transcriptId) return;
    this.last = last;
    this.buildMenu();
  }

  update(state: RecorderState): void {
    this.state = state;
    this.tray.setImage(iconFor(state));
    this.tray.setToolTip(trayTooltip(state, this.testMode));
    this.buildMenu();
  }

  private buildMenu(): void {
    const template: MenuItemConstructorOptions[] = trayMenuItems(this.state, this.last).map((item) => {
      if ("type" in item) return { type: "separator" };
      const action = item.action;
      return { label: item.label, enabled: item.enabled, click: action ? () => this.actions[action]() : undefined };
    });
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  notifyOnce(title: string, content: string): void {
    this.tray.displayBalloon({ title, content, iconType: "info" });
  }

  destroy(): void {
    this.tray.destroy();
  }
}
