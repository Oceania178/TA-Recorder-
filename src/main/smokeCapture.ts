// Developer self-test (`--smoke --smoke-capture`): records ~6 s with one pause into the throwaway smoke
// folder, prints only file names and sizes, then deletes the recording. Proves mic + loopback capture,
// the three recorders, chunk writing and Stop work on this machine. Never used in normal runs.
import type { BrowserWindow } from "electron";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { MARKER_FILE } from "../core/retention";
import { readPcmFile } from "./pcmFiles";
import type { RecorderController } from "./controller";
import { sendCommandToRecorder } from "./windows";

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function waitFor(check: () => boolean, limitMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    if (check()) return true;
    await delay(100);
  }
  return check();
}

async function pageMessage(win: BrowserWindow): Promise<string> {
  return win.webContents.executeJavaScript(`(document.getElementById("message")||{}).textContent||""`).catch(() => "");
}

/** Decodes a file in the page (Chromium's own decoder) and returns duration, channels and loudness per channel. */
async function decodeInPage(win: BrowserWindow, bytes: Buffer): Promise<string> {
  const b64 = JSON.stringify(bytes.toString("base64"));
  const script = `(async () => {
    const raw = Uint8Array.from(atob(${b64}), (c) => c.charCodeAt(0));
    const ctx = new OfflineAudioContext(1, 1, 48000);
    const buf = await ctx.decodeAudioData(raw.buffer);
    const rms = [];
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch); let s = 0;
      for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      const r = Math.sqrt(s / Math.max(1, d.length));
      rms.push(r > 0 ? (20 * Math.log10(r)).toFixed(1) + " dBFS" : "silent");
    }
    return "duration=" + buf.duration.toFixed(2) + "s channels=" + buf.numberOfChannels + " rms=[" + rms.join(", ") + "]";
  })()`;
  return win.webContents.executeJavaScript(script).catch((e: unknown) => `decode failed: ${e instanceof Error ? e.message : "?"}`);
}

/** `--smoke-crash`: kill the recorder page mid-call; the recording must survive, marked "recovered" (R6). */
export async function runCrashSelfTest(win: BrowserWindow, controller: RecorderController): Promise<boolean> {
  sendCommandToRecorder(win, "start");
  if (!(await waitFor(() => controller.guard.state === "recording", 15000))) {
    console.log(`smoke-crash: did not start. Page says: ${await pageMessage(win)}`);
    return false;
  }
  const callId = controller.activeCallId;
  await delay(3000);
  win.webContents.forcefullyCrashRenderer();
  if (!(await waitFor(() => controller.guard.state === "idle", 15000)) || !callId) {
    console.log("smoke-crash: app did not return to idle after the crash");
    return false;
  }
  await waitFor(() => !win.webContents.isLoading() && !win.webContents.isCrashed(), 15000);
  await delay(1000);
  const folder = join(controller.recordingsDir(), callId);
  try {
    const meta = JSON.parse(await readFile(join(folder, `${callId}.call.json`), "utf8"));
    const stereo = await decodeInPage(win, await readFile(join(folder, `${callId}.webm`)));
    console.log(`smoke-crash: status=${meta.status} recovered=${meta.recovered} stereo ${stereo}`);
    return meta.status === "recovered" && /duration=[1-9]/.test(stereo);
  } catch {
    console.log("smoke-crash: no recovered recording found");
    return false;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Decodes the left file the way transcription does (decoder page, 16 kHz float32) and prints only numbers. */
async function decodeForTranscription(decode: (webm: string, pcm: string) => Promise<void>, webm: string): Promise<boolean> {
  const pcm = `${webm}.smoke.pcm`;
  try {
    const started = Date.now();
    await decode(webm, pcm);
    const samples = await readPcmFile(pcm);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / Math.max(1, samples.length));
    const db = rms > 0 ? `${(20 * Math.log10(rms)).toFixed(1)} dBFS` : "silent";
    console.log(`smoke-capture: transcription decode <id>.left.webm -> ${samples.length} samples at 16 kHz = ${(samples.length / 16000).toFixed(2)} s, rms ${db}, in ${Date.now() - started} ms`);
    return samples.length > 16000;
  } catch (e) {
    console.log(`smoke-capture: transcription decode FAILED (${e instanceof Error ? e.message : "?"})`);
    return false;
  } finally {
    await rm(pcm, { force: true });
  }
}

export async function runCaptureSelfTest(
  win: BrowserWindow,
  controller: RecorderController,
  decode?: (webm: string, pcm: string) => Promise<void>,
): Promise<boolean> {
  sendCommandToRecorder(win, "start");
  if (!(await waitFor(() => controller.guard.state === "recording", 15000))) {
    console.log(`smoke-capture: did not start (${controller.guard.state}). Page says: ${await pageMessage(win)}`);
    return false;
  }
  const callId = controller.activeCallId;
  await delay(3000);
  sendCommandToRecorder(win, "pause");
  await delay(1000);
  sendCommandToRecorder(win, "resume");
  await delay(2000);
  sendCommandToRecorder(win, "stop");
  if (!(await waitFor(() => controller.guard.state === "idle", 15000)) || !callId) {
    console.log(`smoke-capture: did not stop cleanly. Page says: ${await pageMessage(win)}`);
    return false;
  }
  const folder = join(controller.recordingsDir(), callId);
  try {
    const files = (await readdir(folder)).sort();
    const needed = [".webm", ".left.webm", ".right.webm", ".call.json"].map((s) => callId + s).concat(MARKER_FILE);
    let ok = needed.every((n) => files.includes(n));
    for (const f of files) {
      const size = (await stat(join(folder, f))).size;
      if (f.endsWith(".webm") && size === 0) ok = false;
      const decoded = f.endsWith(".webm") ? await decodeInPage(win, await readFile(join(folder, f))) : "";
      console.log(`smoke-capture: ${f.replace(callId, "<id>")} ${size} bytes ${decoded}`);
    }
    const meta = JSON.parse(await readFile(join(folder, `${callId}.call.json`), "utf8"));
    console.log(`smoke-capture: status=${meta.status} recorded_ms=${meta.recorded_ms} pauses=${JSON.stringify(meta.pauses)} started=${meta.started_at} ended=${meta.ended_at}`);
    console.log(`smoke-capture: page says: ${await pageMessage(win)}`);
    if (decode) ok = (await decodeForTranscription(decode, join(folder, `${callId}.left.webm`))) && ok;
    return ok && meta.status === "complete" && meta.pauses.length === 1;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
