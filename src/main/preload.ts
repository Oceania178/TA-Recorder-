// The only bridge between the recorder pages and the app. Pages get these few functions, nothing else
// (contextIsolation on, nodeIntegration off, sandboxed).
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type AppMessage, type Command, type MicProcessing, type RecorderApi, type StatusReport, type Track } from "./ipcTypes";

const api: RecorderApi = {
  beginCall: (micProcessing: MicProcessing, intent: "local" | "linked") => ipcRenderer.invoke(IPC.beginCall, micProcessing, intent),
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
  setSolaceAddress: (raw: string) => ipcRenderer.invoke(IPC.setSolaceAddress, raw),
  testSolaceAddress: (raw: string) => ipcRenderer.invoke(IPC.testSolaceAddress, raw),
  setGeminiKey: (raw: string) => ipcRenderer.invoke(IPC.setGeminiKey, raw),
  clearGeminiKey: () => ipcRenderer.invoke(IPC.clearGeminiKey),
  setGeminiModel: (raw: string) => ipcRenderer.invoke(IPC.setGeminiModel, raw),
  setTestMode: (on: boolean) => ipcRenderer.invoke(IPC.setTestMode, on),
  listCalls: () => ipcRenderer.invoke(IPC.listCalls),
  retryCall: (id: string) => ipcRenderer.invoke(IPC.retryCall, id),
  openCallFolder: (id: string) => ipcRenderer.invoke(IPC.openCallFolder, id),
  openTranscript: (id: string) => ipcRenderer.invoke(IPC.openTranscript, id),
  onCallsChanged: (listener: () => void) => {
    ipcRenderer.on(IPC.callsChanged, () => listener());
  },
  acceptNotice: () => ipcRenderer.invoke(IPC.acceptNotice),
  finishWizard: () => ipcRenderer.invoke(IPC.finishWizard),
  openMicSettings: () => ipcRenderer.invoke(IPC.openMicSettings),
  testDial: (phoneNumber: string) => ipcRenderer.invoke(IPC.testDial, phoneNumber),
  onShowWizard: (listener: () => void) => {
    ipcRenderer.on(IPC.showWizard, () => listener());
  },
  onAppMessage: (listener: (message: AppMessage) => void) => {
    ipcRenderer.on(IPC.appMessage, (_event, message: AppMessage) => listener(message));
  },
  sendBarCommand: (command: Command | "open") => ipcRenderer.send(IPC.barCommand, command),
  onStatus: (listener: (status: StatusReport) => void) => {
    ipcRenderer.on(IPC.statusToBar, (_event, status: StatusReport) => listener(status));
  },
};

contextBridge.exposeInMainWorld("recorderApi", api);
