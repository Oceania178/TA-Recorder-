// The hidden window that hosts the decoder page (src/renderer/decoder.ts). Created when a call needs decoding
// and closed again after a minute without work, so it costs nothing between calls. Same lock-down as the
// recorder pages: sandboxed, no node, no network (security.ts), never shown.
import { BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import type { DecoderReply, DecoderRequest, DecoderTransport } from "./decoderClient";
import { IPC } from "./ipcTypes";
import { isOwnPage } from "./security";

const IDLE_CLOSE_MS = 60_000;

export class DecoderWindow implements DecoderTransport {
  private win: BrowserWindow | null = null;
  private ready = false;
  private waiting: DecoderRequest[] = [];
  private listener: (r: DecoderReply) => void = () => undefined;
  private goneListener: () => void = () => undefined;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly rendererDir: string, private readonly preloadPath: string) {
    ipcMain.on(IPC.decoderReply, (event, reply: DecoderReply) => {
      if (!this.win || event.sender !== this.win.webContents || !isOwnPage(event.senderFrame?.url ?? "", rendererDir)) return;
      if (reply?.sid === 0) {
        this.ready = true;
        const queued = this.waiting;
        this.waiting = [];
        for (const r of queued) this.win.webContents.send(IPC.decoderRequest, r);
        return;
      }
      this.armIdle();
      this.listener(reply);
    });
  }

  onReply(listener: (r: DecoderReply) => void): void {
    this.listener = listener;
  }

  /** Review R3 m4: the page crashed — the client fails its waiting requests at once, not after the time-out. */
  onGone(listener: () => void): void {
    this.goneListener = listener;
  }

  send(req: DecoderRequest): void {
    this.armIdle();
    const win = this.ensure();
    if (this.ready) win.webContents.send(IPC.decoderRequest, req);
    else this.waiting.push(req);
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.ready = false;
    const win = new BrowserWindow({
      show: false,
      width: 200,
      height: 100,
      skipTaskbar: true,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    win.webContents.on("render-process-gone", () => {
      this.close();
      this.goneListener();
    });
    void win.loadFile(join(this.rendererDir, "decoder.html"));
    this.win = win;
    return win;
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.ready = false;
    this.waiting = [];
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.destroy();
  }
}
