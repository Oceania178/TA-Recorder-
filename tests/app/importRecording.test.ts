// D-171 "Import recording" (Triet 03/11/2026): the TA picks an existing audio file instead of recording live.
// The copy goes into a call folder like a live call (marker, 3-day delete, OneDrive refusal), is decoded, then
// transcribed and sent with the Solace session like a live call. Without a session: Test mode only (D-165).
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepRecordings, readCallMarker } from "../../src/core/retention";
import { followView } from "../../src/main/barFollow";
import { OutcomeWatcher } from "../../src/main/callOutcomes";
import { callRows, type CallRow } from "../../src/main/callsView";
import { readE2eHooks } from "../../src/main/e2eHooks";
import {
  checkImportFile, importGate, importTimes, IMPORT_EXTENSIONS, MAX_IMPORT_BYTES, MAX_IMPORT_MS, runImport, type ImportDeps,
} from "../../src/main/importFlow";
import type { Job } from "../../src/core";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "tcr-import-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("which files can be imported", () => {
  it("mp3, m4a, wav, webm, ogg and opus; anything else is refused in plain words", () => {
    expect(IMPORT_EXTENSIONS).toEqual([".mp3", ".m4a", ".wav", ".webm", ".ogg", ".opus"]);
    for (const n of ["call.MP3", "x.m4a", "a.wav", "20261029-140305-a1b2c3.webm", "b.ogg", "c.opus"]) expect(checkImportFile({ name: n, size: 1000 })).toMatchObject({ ok: true });
    expect(checkImportFile({ name: "notes.docx", size: 10 })).toEqual({ ok: false, message: "This file type can't be imported. Choose an MP3, M4A, WAV, WebM or OGG (Opus) recording." });
    expect(checkImportFile({ name: "video.mp4", size: 10 }).ok).toBe(false);
  });

  it("empty and too large files are refused, with the limit", () => {
    expect(checkImportFile({ name: "a.mp3", size: 0 })).toEqual({ ok: false, message: "This file is empty." });
    expect(MAX_IMPORT_BYTES).toBe(250 * 1024 * 1024);
    expect(checkImportFile({ name: "a.mp3", size: MAX_IMPORT_BYTES + 1 })).toEqual({ ok: false, message: "This file is larger than 250 MB. Import a recording of up to 2 hours." });
    expect(MAX_IMPORT_MS).toBe(2 * 3600_000);
  });
});

describe("who may import (D-126, D-165, one call at a time)", () => {
  const base = { noticeAccepted: true, testMode: false, linked: true, busy: false };
  it("a Solace call may import; without a session only in Test mode", () => {
    expect(importGate(base)).toBeNull();
    expect(importGate({ ...base, linked: false, testMode: true })).toBeNull();
    expect(importGate({ ...base, linked: false })).toBe('Import a recording from Solace: press "Call & record" (or "Record only, I\'ll call myself") on the candidate, then choose "Import a recording" in the app. To import without Solace, turn on Test mode in Settings.');
  });
  it("the notice comes first; one call or import at a time", () => {
    expect(importGate({ ...base, noticeAccepted: false })).toBe("Open Set-up check and accept the notice first.");
    expect(importGate({ ...base, busy: true })).toBe("Another recording or import is in progress. Finish it first (one call at a time).");
  });
});

describe("the call's times come from the file when they make sense", () => {
  const now = Date.parse("2026-11-03T03:00:00Z");
  it("ended = the file's modified time, started = ended − length", () => {
    const mtime = Date.parse("2026-11-01T02:30:00Z");
    expect(importTimes({ mtimeMs: mtime, durationMs: 1_200_000, nowMs: now })).toEqual({ startedAtMs: mtime - 1_200_000, endedAtMs: mtime, fromFile: true });
  });
  it("a modified time in the future or more than 30 days old is not used: the import time is", () => {
    for (const mtime of [now + 10 * 60_000, now - 31 * 86_400_000]) {
      expect(importTimes({ mtimeMs: mtime, durationMs: 60_000, nowMs: now })).toEqual({ startedAtMs: now - 60_000, endedAtMs: now, fromFile: false });
    }
  });
});

// ---------------------------------------------------------------- runImport on disk
async function makeSource(name: string, bytes = 4096, mtime = Date.parse("2026-11-01T02:30:00Z")): Promise<string> {
  const src = path.join(dir, "from-phone", name);
  await mkdir(path.dirname(src), { recursive: true });
  await writeFile(src, Buffer.alloc(bytes, 7));
  await utimes(src, mtime / 1000, mtime / 1000);
  return src;
}

function deps(over: Partial<ImportDeps> = {}): ImportDeps & { queued: unknown[] } {
  const queued: unknown[] = [];
  return {
    queued,
    root: path.join(dir, "Recordings"),
    dirProblem: () => null,
    hasCall: (id) => existsSync(path.join(dir, "Recordings", id)),
    newLocalId: () => "20261103-100000-abcdef",
    now: () => Date.parse("2026-11-03T03:00:00Z"),
    tzOffsetMinutes: () => 420,
    appVersion: "0.1.5",
    decode: async (_file, outDir, id) => {
      await writeFile(path.join(outDir, `${id}.left.s16`), Buffer.alloc(32));
      await writeFile(path.join(outDir, `${id}.right.s16`), Buffer.alloc(32));
      return { audio: "stereo", durationMs: 1_200_000 };
    },
    enqueue: async (c) => { queued.push(c); },
    progress: () => undefined,
    ...over,
  };
}

const session = { sessionId: "sess-import-0001", dialMode: "self_dial" as const, sendBy: "2026-11-06T03:00:00.000Z" };

describe("runImport: copy, marker, decode, queue", () => {
  it("copies the file into <root>/<session id>/, writes the marker and the call file, and queues the call with the file's times", async () => {
    const d = deps();
    const r = await runImport(d, { source: await makeSource("Ghi âm 0901.m4a"), session, layout: "left-ta" });
    expect(r).toEqual({ ok: true, id: "sess-import-0001", audio: "stereo", fromFileTime: true, durationMs: 1_200_000 });
    const folder = path.join(d.root, "sess-import-0001");
    const files = (await readdir(folder)).sort();
    expect(files).toEqual(["sess-import-0001.call.json", "sess-import-0001.import.m4a", "sess-import-0001.left.s16", "sess-import-0001.right.s16", "ta-call-recorder.call.json"]);
    expect((await stat(path.join(folder, "sess-import-0001.import.m4a"))).size).toBe(4096);
    // the original name (it may hold a candidate's name) is kept nowhere
    expect(JSON.stringify(await readFile(path.join(folder, "sess-import-0001.call.json"), "utf8"))).not.toContain("0901");
    const meta = JSON.parse(await readFile(path.join(folder, "sess-import-0001.call.json"), "utf8"));
    expect(meta).toMatchObject({ call_id: "sess-import-0001", source: "import", audio: "stereo", started_at: "2026-11-01T09:10:00+07:00", ended_at: "2026-11-01T09:30:00+07:00", imported_at: "2026-11-03T10:00:00+07:00", session: { session_id: "sess-import-0001", dial_mode: "self_dial" } });
    // retention counts from the import, not from the (older) recording
    expect(await readCallMarker(folder)).toMatchObject({ id: "sess-import-0001", ended_at: "2026-11-03T10:00:00+07:00" });
    expect(d.queued).toEqual([{ id: "sess-import-0001", folder, startedAtMs: Date.parse("2026-11-01T02:10:00Z"), endedAtMs: Date.parse("2026-11-01T02:30:00Z"), session, audio: "stereo", imported: true }]);
    expect(existsSync(path.join(d.root, ".in-progress", "sess-import-0001"))).toBe(false);
  });

  it("a mono file is queued as mono; without a session the call gets a local id", async () => {
    const d = deps({ decode: async (_f, outDir, id) => { await writeFile(path.join(outDir, `${id}.mono.s16`), Buffer.alloc(32)); return { audio: "mono", durationMs: 60_000 }; } });
    const r = await runImport(d, { source: await makeSource("rec.mp3"), session: null, layout: "left-ta" });
    expect(r).toMatchObject({ ok: true, id: "20261103-100000-abcdef", audio: "mono" });
    expect(d.queued[0]).toMatchObject({ id: "20261103-100000-abcdef", session: null, audio: "mono", imported: true });
  });

  it("refuses an unusable recordings folder (OneDrive), a call already recorded, a bad file — and leaves nothing behind", async () => {
    const one = deps({ dirProblem: () => "This folder is inside OneDrive, which would copy call recordings to the cloud. Choose a folder outside OneDrive." });
    expect(await runImport(one, { source: await makeSource("a.mp3"), session, layout: "left-ta" })).toEqual({ ok: false, message: "This folder is inside OneDrive, which would copy call recordings to the cloud. Choose a folder outside OneDrive." });
    const twice = deps({ hasCall: () => true });
    expect(await runImport(twice, { source: await makeSource("a.mp3"), session, layout: "left-ta" })).toEqual({ ok: false, message: 'This Solace call has already been recorded. Press "Call & record" in Solace again for a new call.' });
    expect(await runImport(deps(), { source: await makeSource("a.docx"), session, layout: "left-ta" })).toMatchObject({ ok: false, message: expect.stringMatching(/can't be imported/) });
    expect(existsSync(path.join(dir, "Recordings", "sess-import-0001"))).toBe(false);
  });

  it("an unreadable or too long recording is refused and its copy deleted", async () => {
    const bad = deps({ decode: async () => { throw new Error("decode_error"); } });
    expect(await runImport(bad, { source: await makeSource("a.mp3"), session, layout: "left-ta" })).toEqual({ ok: false, message: "The app could not read the audio in this file. Try another file, or export the recording again as MP3 or WAV." });
    const long = deps({ decode: async () => ({ audio: "stereo", durationMs: MAX_IMPORT_MS + 1000 }) });
    expect(await runImport(long, { source: await makeSource("b.mp3"), session, layout: "left-ta" })).toEqual({ ok: false, message: "This recording is longer than 2 hours. Import a recording of up to 2 hours." });
    const leftovers = existsSync(path.join(dir, "Recordings")) ? await readdir(path.join(dir, "Recordings"), { recursive: true }) : [];
    expect(leftovers.filter((n) => String(n).includes("sess-import-0001"))).toEqual([]);
  });

  it("the copy is deleted 3 days after the IMPORT by the usual sweep, even when the recording is older", async () => {
    const d = deps();
    await runImport(d, { source: await makeSource("old.wav", 100, Date.parse("2026-10-25T02:00:00Z")), session, layout: "left-ta" });
    const imported = Date.parse("2026-11-03T03:00:00Z");
    const keep = await sweepRecordings({ root: d.root, nowMs: imported + 71 * 3600_000, isBusy: () => false });
    expect(keep).toMatchObject({ deleted: 0, kept: 1 });
    const gone = await sweepRecordings({ root: d.root, nowMs: imported + 73 * 3600_000, isBusy: () => false });
    expect(gone).toMatchObject({ deleted: 1 });
    expect(existsSync(path.join(d.root, "sess-import-0001"))).toBe(false);
  });

  it("reports progress in plain words", async () => {
    const steps: string[] = [];
    await runImport(deps({ progress: (s) => steps.push(s) }), { source: await makeSource("a.mp3"), session, layout: "left-ta" });
    expect(steps).toEqual(["Copying the file…", "Reading the audio…", "Queued for transcription."]);
  });
});

describe("the dev-only import hook stays inert in the installed app", () => {
  it("--e2e-import-file only with --dev --e2e and not packaged; only an absolute path", () => {
    const argv = ["electron", ".", "--dev", "--e2e", "--e2e-import-file=C:\\tmp\\a.wav"];
    expect(readE2eHooks(argv, false)?.importFile).toBe("C:\\tmp\\a.wav");
    expect(readE2eHooks(argv, true)).toBeNull();
    expect(readE2eHooks(["electron", ".", "--e2e-import-file=C:\\tmp\\a.wav"], false)).toBeNull();
    expect(readE2eHooks(["electron", ".", "--dev", "--e2e", "--e2e-import-file=relative.wav"], false)?.importFile).toBeNull();
  });
});

// ---------------------------------------------------------------- what the TA sees
function job(over: Partial<Job> = {}): Job {
  return {
    id: "sess-import-0001", sessionId: "sess-import-0001", dialMode: "self_dial", folder: "x",
    startedAt: "2026-11-01T09:10:00+07:00", endedAt: "2026-11-01T09:30:00+07:00", sendBy: null,
    stage: "transcribed", attempts: 0, nextAttemptAt: null, callId: null, duplicate: false, failure: null, createdAt: "", updatedAt: "",
    imported: true, audio: "mono", speakersNeeded: true, ...over,
  };
}

describe("Recent calls, the bar and the notification for a mono import", () => {
  it("the row asks the TA to choose their voice and says the call was imported", () => {
    const [row] = callRows([job()], { hasKey: true, transcriptIds: new Set() });
    expect(row).toMatchObject({ stage: "Transcribed", needsSpeakers: true, imported: true, detail: "Choose which voice is yours, then it is sent." });
    const [local] = callRows([job({ sessionId: null, dialMode: null })], { hasKey: true, transcriptIds: new Set() });
    expect(local.detail).toBe("Choose which voice is yours (Local only — never sent).");
    const [live] = callRows([job({ imported: undefined, audio: undefined, speakersNeeded: undefined, stage: "sent" })], { hasKey: true, transcriptIds: new Set() });
    expect(live).toMatchObject({ needsSpeakers: false, imported: false });
  });

  it("the bar says what to do", () => {
    const row: CallRow = callRows([job()], { hasKey: true, transcriptIds: new Set() })[0];
    expect(followView(row)).toMatchObject({ text: "Choose which voice is yours (open the recorder)", final: false, canRetry: false });
  });

  it("one notification asks for the choice (Solace and Local only calls alike)", () => {
    const w = new OutcomeWatcher();
    const transcribing = callRows([job({ stage: "transcribing", speakersNeeded: undefined })], { hasKey: true, transcriptIds: new Set() });
    w.update(transcribing);
    const ready = callRows([job()], { hasKey: true, transcriptIds: new Set() });
    const out = w.update(ready);
    expect(out).toEqual([{ id: "sess-import-0001", outcome: "choose", title: "TA Call Recorder", body: expect.stringMatching(/^Call of \d\d:\d\d is transcribed\. Open TA Call Recorder and choose which voice is yours\.$/) }]);
    expect(w.update(ready)).toEqual([]);
  });
});
