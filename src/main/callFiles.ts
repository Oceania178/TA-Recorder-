// File and folder names for one call. Everything is named after the call id only (D-84).
import type { Track } from "./ipcTypes";

export type { Track };
export const TRACKS: readonly Track[] = ["stereo", "left", "right"];

/** Calls being recorded live here (as .part files) until Stop moves them to <root>/<id>/. */
export const IN_PROGRESS_DIR = ".in-progress";

const SUFFIX: Record<Track, string> = { stereo: ".webm", left: ".left.webm", right: ".right.webm" };

export function callFileNames(id: string): { stereo: string; left: string; right: string; meta: string } {
  return { stereo: id + SUFFIX.stereo, left: id + SUFFIX.left, right: id + SUFFIX.right, meta: `${id}.call.json` };
}

export function partFileName(id: string, track: Track): string {
  return `${id}${SUFFIX[track]}.part`;
}

export function isTrack(value: unknown): value is Track {
  return value === "stereo" || value === "left" || value === "right";
}
