// D-39: the recorder records one call at a time. This tracks where we are and refuses a second start.
import type { RecorderState } from "./ipcTypes";

export type { RecorderState };
export type BeginCheck = { ok: true } | { ok: false; message: string };

export const ALREADY_RECORDING_MESSAGE =
  "Already recording a call. Stop the current recording before starting a new one (one call at a time).";

export class SessionGuard {
  state: RecorderState = "idle";
  activeCallId: string | null = null;

  tryBegin(): BeginCheck {
    if (this.state !== "idle") return { ok: false, message: ALREADY_RECORDING_MESSAGE };
    this.state = "starting";
    return { ok: true };
  }

  started(callId: string): void {
    if (this.state !== "starting") return;
    this.state = "recording";
    this.activeCallId = callId;
  }

  paused(): void {
    if (this.state === "recording") this.state = "paused";
  }

  resumed(): void {
    if (this.state === "paused") this.state = "recording";
  }

  stopping(): void {
    if (this.state === "recording" || this.state === "paused") this.state = "stopping";
  }

  /** The call finished, failed to start, or was lost: back to idle. */
  ended(): void {
    this.state = "idle";
    this.activeCallId = null;
  }

  get isActive(): boolean {
    return this.state !== "idle";
  }
}
