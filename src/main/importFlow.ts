// D-171 "Import recording" (Triet 03/11/2026): instead of recording live, the TA picks an existing audio file
// (a phone or Sound Recorder recording, or an older file of this app). It becomes a call like any other:
//   1. who may import: the notice first (D-126); with a Solace session (opened from "Call & record" /
//      "Record only, I'll call myself"), or without one only in Test mode, as a Local only call (D-165);
//      one call or import at a time (D-39);
//   2. the file is checked (type, size) and COPIED into <root>\.in-progress\<id>\<id>.import.<ext> — the
//      original is never touched, and its name (it may hold a candidate's name) is kept nowhere;
//   3. the copy is decoded to 16 kHz (decoderClient.ts decodeFileToPcm): two different channels = the app's
//      stereo layout (left = TA, right = candidate); one channel, or the same sound on both = mono (the
//      speakers are told apart by Gemini, core/diarize.ts); at most 2 hours;
//   4. the call's times: the file's modified time is taken as the end of the recording, the start = end −
//      length (when that time is plausible: not in the future, not older than 30 days), else the import time;
//   5. <id>.call.json and the retention marker are written — the marker's end time is the IMPORT time, so the
//      copy is deleted 3 days after the import like every recording (D-140) — then the folder is moved to
//      <root>\<id>\ and the call is queued (transcribed and sent exactly like a live call).
// Every refusal leaves nothing behind. All I/O but the copy and the folder moves is passed in (tests).
import { copyFile, mkdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { formatIsoWithOffset, writeCallMarker } from "../core";
import { NOTICE_FIRST_MESSAGE, type LinkedSession } from "./deepLinkFlow";

export const IMPORT_EXTENSIONS = [".mp3", ".m4a", ".wav", ".webm", ".ogg", ".opus"];
/** The decoder holds the whole decoded file in memory: these keep it to about 1 GB at most. */
export const MAX_IMPORT_BYTES = 250 * 1024 * 1024;
export const MAX_IMPORT_MS = 2 * 3600_000;
/** A file time older than this is not taken as the recording's time. */
const MAX_FILE_AGE_MS = 30 * 86_400_000;
const FUTURE_SLACK_MS = 2 * 60_000;

export type ImportAudio = "stereo" | "mono";

export const IMPORT_MESSAGES = {
  type: "This file type can't be imported. Choose an MP3, M4A, WAV, WebM or OGG (Opus) recording.",
  empty: "This file is empty.",
  tooLarge: "This file is larger than 250 MB. Import a recording of up to 2 hours.",
  tooLong: "This recording is longer than 2 hours. Import a recording of up to 2 hours.",
  unreadable: "The app could not read the audio in this file. Try another file, or export the recording again as MP3 or WAV.",
  noSession: 'Import a recording from Solace: press "Call & record" (or "Record only, I\'ll call myself") on the candidate, then choose "Import a recording" in the app. To import without Solace, turn on Test mode in Settings.',
  busy: "Another recording or import is in progress. Finish it first (one call at a time).",
  already: 'This Solace call has already been recorded. Press "Call & record" in Solace again for a new call.',
  copyFailed: "The file could not be copied into the recordings folder. Check free space, then try again.",
} as const;

export function checkImportFile(f: { name: string; size: number }): { ok: true; ext: string } | { ok: false; message: string } {
  const ext = extname(f.name).toLowerCase();
  if (!IMPORT_EXTENSIONS.includes(ext)) return { ok: false, message: IMPORT_MESSAGES.type };
  if (!(f.size > 0)) return { ok: false, message: IMPORT_MESSAGES.empty };
  if (f.size > MAX_IMPORT_BYTES) return { ok: false, message: IMPORT_MESSAGES.tooLarge };
  return { ok: true, ext };
}

/** Null when the import may go ahead, else why not (the same rules as a live start). */
export function importGate(g: { noticeAccepted: boolean; testMode: boolean; linked: boolean; busy: boolean }): string | null {
  if (!g.noticeAccepted) return NOTICE_FIRST_MESSAGE;
  if (!g.linked && !g.testMode) return IMPORT_MESSAGES.noSession;
  if (g.busy) return IMPORT_MESSAGES.busy;
  return null;
}

export function importTimes(t: { mtimeMs: number; durationMs: number; nowMs: number }): { startedAtMs: number; endedAtMs: number; fromFile: boolean } {
  const d = Math.max(0, Math.round(t.durationMs));
  const plausible = Number.isFinite(t.mtimeMs) && t.mtimeMs <= t.nowMs + FUTURE_SLACK_MS && t.mtimeMs >= t.nowMs - MAX_FILE_AGE_MS && t.mtimeMs - d > 0;
  const end = plausible ? Math.round(t.mtimeMs) : t.nowMs;
  return { startedAtMs: end - d, endedAtMs: end, fromFile: plausible };
}

export interface QueuedImport {
  id: string;
  folder: string;
  startedAtMs: number;
  endedAtMs: number;
  session: LinkedSession | null;
  audio: ImportAudio;
  imported: true;
}

export interface ImportDeps {
  /** The recordings folder (controller.recordingsDir()). */
  root: string;
  /** Why the recordings folder cannot be used (OneDrive, network…), or null. */
  dirProblem(): string | null;
  /** A call folder (or recording) with this id exists already. */
  hasCall(id: string): boolean;
  newLocalId(): string;
  now(): number;
  tzOffsetMinutes(ms: number): number;
  appVersion: string;
  /** Decode `file` into 16 kHz PCM files in `outDir` (decoderClient.ts decodeFileToPcm). */
  decode(file: string, outDir: string, id: string, forceMono: boolean): Promise<{ audio: ImportAudio; durationMs: number }>;
  enqueue(call: QueuedImport): Promise<void>;
  progress(step: string): void;
}

export type ImportResult =
  | { ok: true; id: string; audio: ImportAudio; fromFileTime: boolean; durationMs: number }
  | { ok: false; message: string };

export async function runImport(d: ImportDeps, o: { source: string; session: LinkedSession | null; forceMono: boolean }): Promise<ImportResult> {
  const problem = d.dirProblem();
  if (problem) return { ok: false, message: problem };
  let st;
  try {
    st = await stat(o.source);
  } catch {
    return { ok: false, message: IMPORT_MESSAGES.unreadable };
  }
  const check = checkImportFile({ name: basename(o.source), size: st.isFile() ? st.size : 0 });
  if (!check.ok) return check;
  const id = o.session ? o.session.sessionId : d.newLocalId();
  if (d.hasCall(id)) return { ok: false, message: IMPORT_MESSAGES.already };

  const tmp = join(d.root, ".in-progress", id);
  const final = join(d.root, id);
  const fail = async (message: string): Promise<ImportResult> => {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, message };
  };
  const copy = join(tmp, `${id}.import${check.ext}`);
  try {
    d.progress("Copying the file…");
    await mkdir(tmp, { recursive: true });
    await copyFile(o.source, copy);
    // Windows keeps the source's modified time on a copy: an old one would let the hourly sweep of
    // ".in-progress" delete the copy while it is decoded. The recording's own time was read above.
    const t = d.now() / 1000;
    await utimes(copy, t, t);
  } catch {
    return fail(IMPORT_MESSAGES.copyFailed);
  }

  d.progress("Reading the audio…");
  let decoded: { audio: ImportAudio; durationMs: number };
  try {
    decoded = await d.decode(copy, tmp, id, o.forceMono);
  } catch {
    return fail(IMPORT_MESSAGES.unreadable);
  }
  if (!(decoded.durationMs > 0)) return fail(IMPORT_MESSAGES.unreadable);
  if (decoded.durationMs > MAX_IMPORT_MS) return fail(IMPORT_MESSAGES.tooLong);

  const now = d.now();
  const times = importTimes({ mtimeMs: st.mtimeMs, durationMs: decoded.durationMs, nowMs: now });
  const iso = (ms: number) => formatIsoWithOffset(ms, d.tzOffsetMinutes(ms));
  try {
    await writeFile(join(tmp, `${id}.call.json`), JSON.stringify({
      schema: 1,
      call_id: id,
      source: "import",
      audio: decoded.audio,
      started_at: iso(times.startedAtMs),
      ended_at: iso(times.endedAtMs),
      times_from_file: times.fromFile,
      imported_at: iso(now),
      file: `${id}.import${check.ext}`,
      app_version: d.appVersion,
      session: o.session ? { session_id: o.session.sessionId, dial_mode: o.session.dialMode, send_by: o.session.sendBy } : null,
    }, null, 2), "utf8");
    // D-140: the 3 days count from the import (the marker's end time), not from the older recording.
    await writeCallMarker(tmp, { id, startedAt: iso(times.startedAtMs), endedAt: iso(now) });
    await mkdir(d.root, { recursive: true });
    await rename(tmp, final);
  } catch {
    return fail(IMPORT_MESSAGES.copyFailed);
  }
  await d.enqueue({ id, folder: final, startedAtMs: times.startedAtMs, endedAtMs: times.endedAtMs, session: o.session, audio: decoded.audio, imported: true });
  d.progress("Queued for transcription.");
  return { ok: true, id, audio: decoded.audio, fromFileTime: times.fromFile, durationMs: decoded.durationMs };
}
