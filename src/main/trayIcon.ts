// Draws the tray icon (a coloured dot) in code, so the app needs no image files.
// D-42: three states — grey idle, red recording, amber paused.
import type { RecorderState } from "./ipcTypes";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const TRAY_COLOURS: Record<"idle" | "recording" | "paused", Rgb> = {
  idle: { r: 120, g: 120, b: 120 },
  recording: { r: 220, g: 38, b: 38 },
  paused: { r: 217, g: 119, b: 6 },
};

export function trayColourFor(state: RecorderState): Rgb {
  if (state === "recording" || state === "stopping") return TRAY_COLOURS.recording;
  if (state === "paused") return TRAY_COLOURS.paused;
  return TRAY_COLOURS.idle;
}

/** A size x size BGRA bitmap (what Electron's nativeImage.createFromBitmap expects) with an anti-aliased dot. */
export function dotBitmap(size: number, colour: Rgb): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const centre = size / 2;
  const radius = size * 0.4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - centre, y + 0.5 - centre);
      const coverage = Math.max(0, Math.min(1, radius - d + 0.5));
      const i = (y * size + x) * 4;
      buf[i] = colour.b;
      buf[i + 1] = colour.g;
      buf[i + 2] = colour.r;
      buf[i + 3] = Math.round(coverage * 255);
    }
  }
  return buf;
}
