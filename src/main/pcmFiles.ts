// Temp PCM files for transcription (controller decision, 29/10/2026): each mono recording
// (<id>.left.webm, <id>.right.webm) is decoded once, at 16 kHz, into raw 32-bit float samples
// (<id>.left.pcm, <id>.right.pcm) inside the call's own folder. Core's loadPcm reads them; they are deleted
// after the transcript is written (and with the folder by the 3-day sweep in any case).
// A decode writes to "<file>.part" and renames at the end, so a crash never leaves a half file that looks done.
import { open, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DecodedCall, Job } from "../core";

export const PCM_SAMPLE_RATE = 16_000;

export function pcmPaths(folder: string, id: string): { left: string; right: string } {
  return { left: join(folder, `${id}.left.pcm`), right: join(folder, `${id}.right.pcm`) };
}

function webmPaths(folder: string, id: string): { left: string; right: string } {
  return { left: join(folder, `${id}.left.webm`), right: join(folder, `${id}.right.webm`) };
}

/** Reads a raw little-endian float32 file straight into a Float32Array (no extra copy). */
export async function readPcmFile(file: string): Promise<Float32Array> {
  const size = (await stat(file)).size;
  const out = new Float32Array(Math.floor(size / 4));
  const fh = await open(file, "r");
  try {
    const bytes = new Uint8Array(out.buffer);
    let done = 0;
    while (done < bytes.length) {
      const { bytesRead } = await fh.read(bytes, done, bytes.length - done, done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return out;
}

export async function deletePcmFiles(folder: string, id: string): Promise<void> {
  const p = pcmPaths(folder, id);
  for (const f of [p.left, p.right]) {
    await rm(f, { force: true });
    await rm(`${f}.part`, { force: true });
  }
}

/** decode(webmFile, pcmFile): writes 16 kHz float32 PCM of webmFile to pcmFile (main: the decoder page). */
export type DecodeToFile = (webmFile: string, pcmFile: string) => Promise<void>;

/** Core's loadPcm: decode what is not decoded yet, then read both channels. Null when the audio is missing. */
export function makeLoadPcm(decode: DecodeToFile): (job: Job) => Promise<DecodedCall | null> {
  return async (job) => {
    const webm = webmPaths(job.folder, job.id);
    const pcm = pcmPaths(job.folder, job.id);
    if (!existsSync(webm.left) || !existsSync(webm.right)) return null;
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
    return { left: await readPcmFile(pcm.left), right: await readPcmFile(pcm.right), sampleRate: PCM_SAMPLE_RATE };
  };
}
