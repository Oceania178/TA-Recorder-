// The floating bar's own bridge (APP review M11): it only shows the recorder's status (and, after Stop, the saved
// call's stage — UX round 2, P3) and sends its buttons (D-171: "import" opens the import dialog in the window). Nothing else of the app is reachable from it.
import { contextBridge, ipcRenderer } from "electron";
import type { BarFollowView } from "./barFollow";
import { IPC, type Command, type StatusReport } from "./ipcTypes";

/** The bar's buttons: Pause / Resume / Stop while recording; Open; after Stop, "retry" (Failed) and "close". */
export type BarCommand = Exclude<Command, "start" | "startLinked"> | "open" | "retry" | "close" | "import";

export interface BarApi {
  sendBarCommand(command: BarCommand): void;
  onStatus(listener: (status: StatusReport) => void): void;
  /** null: back to the live view (a new recording) or nothing to follow. */
  onFollow(listener: (follow: BarFollowView | null) => void): void;
}

const api: BarApi = {
  sendBarCommand: (command) => ipcRenderer.send(IPC.barCommand, command),
  onStatus: (listener) => {
    ipcRenderer.on(IPC.statusToBar, (_event, status: StatusReport) => listener(status));
  },
  onFollow: (listener) => {
    ipcRenderer.on(IPC.followToBar, (_event, follow: BarFollowView | null) => listener(follow));
  },
};

contextBridge.exposeInMainWorld("barApi", api);
