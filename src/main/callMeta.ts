// The <id>.call.json file kept next to the audio: when the call ran, its pauses and how it ended.
import { rename, writeFile } from "node:fs/promises";
import type { MicProcessing } from "./ipcTypes";

export interface PauseMark {
  /** Where the pause sits in the recorded audio (ms from the start of the file). */
  at_recorded_ms: number;
  paused_at: string;
  resumed_at: string | null;
}

export interface CallMeta {
  schema: 1;
  call_id: string;
  status: "recording" | "complete" | "recovered";
  recovered: boolean;
  started_at: string | null;
  ended_at: string | null;
  /** Audio length in the files: wall time minus pauses. */
  recorded_ms: number | null;
  /** "cut": paused time is not in the audio; the pauses list says where it was cut (R5). */
  pause_handling: "cut";
  pauses: PauseMark[];
  mic_processing: MicProcessing | null;
  files: { stereo: string; left: string; right: string };
  app_version: string | null;
  /** The Solace session this call belongs to (Step 5), or null/absent for a local-only call (D-82). No ticket here. */
  session?: { session_id: string; dial_mode: "3cx" | "self_dial"; send_by: string } | null;
}

/** Write via a temp file and rename, so a crash never leaves half a JSON file. */
export async function writeMetaAtomic(file: string, meta: CallMeta): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
  await rename(tmp, file);
}
