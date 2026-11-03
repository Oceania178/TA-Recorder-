// What the preload puts on window, typed for the renderer pages.
import type { Command, RecorderApi } from "../main/ipcTypes";

declare global {
  interface Window {
    recorderApi: RecorderApi;
    /** Called by main (tray, shortcuts, floating bar) through executeJavaScript with a user gesture. */
    __taRecorderCommand?: (command: Command | "settings" | "calls" | "import" | "speakers") => void;
  }
}

export const api = (): RecorderApi => window.recorderApi;
