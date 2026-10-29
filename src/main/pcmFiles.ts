// Temp PCM files for transcription (controller decision, 29/10/2026): each mono recording
// (<id>.left.webm, <id>.right.webm) is decoded once, at 16 kHz, into raw 16-bit little-endian samples
// (<id>.left.s16, <id>.right.s16; fix round 3, m-R4: half the disk of float32 — about 0.46 GB per channel for a
// 4-hour call) inside the call's own folder. Core's loadPcm reads them; they are deleted
// after the transcript is written (and with the folder by the 3-day sweep in any case).
// A decode writes to "<file>.part" and renames at the end, so a crash never leaves a half file that looks done.
import { open, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DecodedCall, Job, PcmReader, PcmSource } from "../core";

export const PCM_SAMPLE_RATE = 16_000;

export function pcmPaths(folder: string, id: string): { left: string; right: string } {
  return { left: join(folder, `${id}.left.s16`), right: join(folder, `${id}.right.s16`) };
}

function webmPaths(folder: string, id: string): { left: string; right: string } {
  return { left: join(folder, `${id}.left.webm`), right: join(folder, `${id}.right.webm`) };
}

/** Reads a whole raw 16-bit file as floats (short calls and the self-test only). */
export async function readPcmFile(file: string): Promise<Float32Array> {
  const size = (await stat(file)).size;
  const bytes = new Uint8Array(size - (size % 2));
  const fh = await open(file, "r");
  try {
    let done = 0;
    while (done < bytes.length) {
      const { bytesRead } = await fh.read(bytes, done, bytes.length - done, done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return int16ToFloat(bytes);
}

export async function deletePcmFiles(folder: string, id: string): Promise<void> {
  const p = pcmPaths(folder, id);
  // The .pcm names are the float32 files of builds before fix round 3.
  const old = [join(folder, `${id}.left.pcm`), join(folder, `${id}.right.pcm`)];
  for (const f of [p.left, p.right, ...old]) {
    await rm(f, { force: true });
    await rm(`${f}.part`, { force: true });
  }
}

/** decode(webmFile, pcmFile): writes 16 kHz 16-bit PCM of webmFile to pcmFile (main: the decoder page). */
export type DecodeToFile = (webmFile: string, pcmFile: string) => Promise<void>;

/** Decode each mono file that is not decoded yet (to "<file>.part", then renamed). False when audio is missing. */
async function ensureDecoded(decode: DecodeToFile, job: Job): Promise<boolean> {
  const webm = webmPaths(job.folder, job.id);
  const pcm = pcmPaths(job.folder, job.id);
  if (!existsSync(webm.left) || !existsSync(webm.right)) return false;
  for (const side of ["left", "right"] as const) {
    if (existsSync(pcm[side])) continue;
    const part = `${pcm[side]}.part`;
    try {
      await rm(part, { force: true });
      await decode(webm[side], part);
      await rename(part, pcm[side]);
    } catch (e) {
      await rm(part, { force: true });
      throw e;
    }
  }
  return true;
}

/** The whole call in memory (short calls and tests only; the app uses makeOpenPcm). */
export function makeLoadPcm(decode: DecodeToFile): (job: Job) => Promise<DecodedCall | null> {
  return async (job) => {
    if (!(await ensureDecoded(decode, job))) return null;
    const pcm = pcmPaths(job.folder, job.id);
    return { left: await readPcmFile(pcm.left), right: await readPcmFile(pcm.right), sampleRate: PCM_SAMPLE_RATE };
  };
}

/** One channel's temp file as a reader: each read takes only the samples asked for (APP review I3). */
export async function openPcmReader(file: string): Promise<PcmReader & { close(): Promise<void> }> {
  const fh = await open(file, "r");
  const length = Math.floor((await fh.stat()).size / 2);
  return {
    length,
    read: async (start, count) => {
      const from = Math.max(0, Math.min(length, start));
      const n = Math.max(0, Math.min(count, length - from));
      const bytes = new Uint8Array(n * 2);
      let done = 0;
      while (done < bytes.length) {
        const { bytesRead } = await fh.read(bytes, done, bytes.length - done, from * 2 + done);
        if (bytesRead === 0) break;
        done += bytesRead;
      }
      return int16ToFloat(bytes.subarray(0, done - (done % 2)));
    },
    close: () => fh.close(),
  };
}

/** Core's openPcm: decode what is not decoded yet, then open both channels as readers. Null when audio is missing. */
export function makeOpenPcm(decode: DecodeToFile): (job: Job) => Promise<PcmSource | null> {
  return async (job) => {
    if (!(await ensureDecoded(decode, job))) return null;
    const pcm = pcmPaths(job.folder, job.id);
    const left = await openPcmReader(pcm.left);
    let right: PcmReader & { close(): Promise<void> };
    try {
      right = await openPcmReader(pcm.right);
    } catch (e) {
      await left.close();
      throw e;
    }
    return {
      sampleRate: PCM_SAMPLE_RATE,
      left,
      right,
      close: async () => {
        await left.close().catch(() => undefined);
        await right.close().catch(() => undefined);
      },
    };
  };
}

/** Float samples (-1..1) as 16-bit integers, clamped: how the decoded audio is stored (half of float32). */
export function floatToInt16(pcm: Float32Array): Int16Array {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i] || 0));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

function int16ToFloat(bytes: Uint8Array): Float32Array {
  const ints = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const out = new Float32Array(ints.length);
  for (let i = 0; i < ints.length; i++) out[i] = ints[i] < 0 ? ints[i] / 0x8000 : ints[i] / 0x7fff;
  return out;
}
