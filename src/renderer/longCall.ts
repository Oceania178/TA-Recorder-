// A forgotten Stop (APP review I3): a warning at 3 h 50 of recorded time, and the recording stops and is
// saved at 4 h. Long enough for any phone screen; keeps the files and the transcription reasonable.
export const LONG_CALL_WARN_MS = (3 * 60 + 50) * 60_000;
export const LONG_CALL_STOP_MS = 4 * 3600_000;

export const LONG_CALL_WARNING = "This recording has run for almost 4 hours. It stops and is saved at 4 hours — press Stop if the call is over.";
export const LONG_CALL_STOPPED = "The recording reached 4 hours, so it was stopped and saved. Start a new one if the call goes on.";

export function longCallStatus(recordedMs: number): "ok" | "warn" | "stop" {
  if (recordedMs >= LONG_CALL_STOP_MS) return "stop";
  if (recordedMs >= LONG_CALL_WARN_MS) return "warn";
  return "ok";
}
