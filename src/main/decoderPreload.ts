// Bridge for the hidden decoder page: it receives batches of Opus packets and sends back 16 kHz samples.
// Nothing else (no files, no network: main reads the file and the page never sees a path).
import { contextBridge, ipcRenderer } from "electron";
import type { DecoderReply, DecoderRequest } from "./decoderClient";
import { IPC } from "./ipcTypes";

export interface DecoderBridge {
  onRequest(listener: (req: DecoderRequest) => void): void;
  reply(r: DecoderReply): void;
  ready(): void;
}

const bridge: DecoderBridge = {
  onRequest: (listener) => {
    ipcRenderer.on(IPC.decoderRequest, (_event, req: DecoderRequest) => listener(req));
  },
  reply: (r) => ipcRenderer.send(IPC.decoderReply, r),
  ready: () => ipcRenderer.send(IPC.decoderReply, { sid: 0, ok: true }),
};

contextBridge.exposeInMainWorld("decoderBridge", bridge);
