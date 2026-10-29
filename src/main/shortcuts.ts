// Global shortcuts (spec §1, §8.22 Step 1). The map is here so the UI shows exactly what is registered.
import type { Command, RecorderState } from "./ipcTypes";

export type ShortcutAction = "toggleRecord" | "togglePause";

export const SHORTCUTS: Record<ShortcutAction, { accelerator: string; label: string }> = {
  toggleRecord: { accelerator: "Control+Alt+R", label: "Ctrl+Alt+R" },
  togglePause: { accelerator: "Control+Alt+P", label: "Ctrl+Alt+P" },
};

/** What a shortcut does right now; null while a start or stop is still in progress. */
export function commandForShortcut(action: ShortcutAction, state: RecorderState): Command | null {
  if (action === "toggleRecord") {
    if (state === "idle") return "start";
    if (state === "recording" || state === "paused") return "stop";
    return null;
  }
  if (state === "recording") return "pause";
  if (state === "paused") return "resume";
  return null;
}
