// The floating bar's own bridge (APP review M11): it only shows the recorder's status and sends its three
// buttons. Nothing else of the app is reachable from it.
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type Command, type StatusReport } from "./ipcTypes";

export interface BarApi {
  sendBarCommand(command: Exclude<Command, "start" | "startLinked"> | "open"): void;
  onStatus(listener: (status: StatusReport) => void): void;
}

const api: BarApi = {
  sendBarCommand: (command) => ipcRenderer.send(IPC.barCommand, command),
  onStatus: (listener) => {
    ipcRenderer.on(IPC.statusToBar, (_event, status: StatusReport) => listener(status));
  },
};

contextBridge.exposeInMainWorld("barApi", api);
