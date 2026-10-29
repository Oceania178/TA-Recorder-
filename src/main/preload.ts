// The only bridge between the recorder pages and the app. Pages get these few functions, nothing else
// (contextIsolation on, nodeIntegration off, sandboxed).
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type Command, type MicProcessing, type RecorderApi, type StatusReport, type Track } from "./ipcTypes";

const api: RecorderApi = {
  beginCall: (micProcessing: MicProcessing) => ipcRenderer.invoke(IPC.beginCall, micProcessing),
  appendChunk: (callId: string, track: Track, data: ArrayBuffer) => ipcRenderer.invoke(IPC.appendChunk, callId, track, data),
  markPause: (callId: string, kind: "pause" | "resume", recordedMs: number) => ipcRenderer.invoke(IPC.markPause, callId, kind, recordedMs),
  endCall: (callId: string, recordedMs: number) => ipcRenderer.invoke(IPC.endCall, callId, recordedMs),
  abortCall: (callId: string) => ipcRenderer.invoke(IPC.abortCall, callId),
  reportStatus: (status: StatusReport) => ipcRenderer.send(IPC.status, status),
  rendererReady: () => ipcRenderer.send(IPC.ready),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  chooseRecordingsDir: () => ipcRenderer.invoke(IPC.chooseDir),
  setMicProcessing: (on: boolean) => ipcRenderer.invoke(IPC.setMicProcessing, on),
  openRecordingsFolder: () => ipcRenderer.invoke(IPC.openFolder),
  sendBarCommand: (command: Command | "open") => ipcRenderer.send(IPC.barCommand, command),
  onStatus: (listener: (status: StatusReport) => void) => {
    ipcRenderer.on(IPC.statusToBar, (_event, status: StatusReport) => listener(status));
  },
};

contextBridge.exposeInMainWorld("recorderApi", api);
