// P2 (UX round 2): a call started from Solace's "Call & record" leaves Solace in front. The recorder window is
// hidden once the linked recording runs (the floating bar shows it); if the start fails, or never happens, the
// window comes forward so the TA sees why. A local (Test mode) start is not affected.
import type { RecorderState } from "./ipcTypes";

export class LinkStartWindow {
  private phase: "none" | "armed" | "starting" = "none";

  /** A Solace link passed the ticket check and the page is about to press Start. */
  linkStarted(): void {
    this.phase = "armed";
  }

  /** The recorder page's state (reported several times a second): what to do with the recorder window. */
  status(state: RecorderState): "hide" | "show" | null {
    if (this.phase === "none") return null;
    if (state === "starting") {
      this.phase = "starting";
      return null;
    }
    if (state === "recording" || state === "paused") {
      this.phase = "none";
      return "hide";
    }
    if (state === "idle" && this.phase === "starting") {
      this.phase = "none";
      return "show";
    }
    return null;
  }

  /** No recording a while after the link: show the window (its message says why). */
  timedOut(): "show" | null {
    if (this.phase === "none") return null;
    this.phase = "none";
    return "show";
  }
}
