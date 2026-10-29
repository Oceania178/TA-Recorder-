import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sweepRecordings, writeCallMarker, readCallMarker, RETENTION_MS, MARKER_FILE } from "../../src/core/retention";

const NOW = Date.parse("2026-10-29T02:00:00Z");
const DAY = 24 * 3600_000;
let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "tcr-retention-"));
  outside = await mkdtemp(path.join(os.tmpdir(), "tcr-outside-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function call(id: string, endedAgoMs: number | null, extra: string[] = ["audio.webm", `${id}.transcript.md`]) {
  const dir = path.join(root, id);
  await mkdir(dir);
  await writeCallMarker(dir, { id, startedAt: new Date(NOW - (endedAgoMs ?? 0) - 600_000).toISOString(), endedAt: endedAgoMs === null ? null : new Date(NOW - endedAgoMs).toISOString() });
  for (const f of extra) await writeFile(path.join(dir, f), "x");
  return dir;
}

describe("retention (D-140: 3 days, permanent, only the app's own folders)", () => {
  it("is 72 hours", () => expect(RETENTION_MS).toBe(72 * 3600_000));

  it("deletes calls that ended more than 3 days ago and keeps newer ones", async () => {
    await call("old_call_1", 4 * DAY);
    await call("edge_call1", RETENTION_MS + 1);
    await call("new_call_1", 1 * DAY);
    const r = await sweepRecordings({ root, nowMs: NOW, isBusy: () => false });
    expect(r).toMatchObject({ deleted: 2, kept: 1, busy: 0, notOurs: 0, errors: 0 });
    expect(r.deletedIds.sort()).toEqual(["edge_call1", "old_call_1"]);
    expect(await readdir(root)).toEqual(["new_call_1"]);
    expect(r.at).toBe(new Date(NOW).toISOString());
  });

  it("deletes regardless of the job's stage, but never while it is being transcribed or sent", async () => {
    await call("busy_call1", 5 * DAY);
    const r = await sweepRecordings({ root, nowMs: NOW, isBusy: (id) => id === "busy_call1" });
    expect(r).toMatchObject({ deleted: 0, busy: 1 });
    expect(await readdir(root)).toEqual(["busy_call1"]);
  });

  it("never touches a folder or file the app did not create", async () => {
    await mkdir(path.join(root, "my_photos"));
    await writeFile(path.join(root, "my_photos", "a.jpg"), "x");
    await writeFile(path.join(root, "loose.txt"), "x");
    const wrong = await call("other_id12", 9 * DAY);
    await writeFile(path.join(wrong, MARKER_FILE), JSON.stringify({ app: "ta-call-recorder", id: "not_this_folder", ended_at: new Date(NOW - 9 * DAY).toISOString() }));
    const r = await sweepRecordings({ root, nowMs: NOW, isBusy: () => false });
    expect(r).toMatchObject({ deleted: 0, notOurs: 2 });
    expect((await readdir(root)).sort()).toEqual(["loose.txt", "my_photos", "other_id12"]);
  });

  it("a recording that never got an end time (crash) is judged by its newest file", async () => {
    const dir = await call("crashed_01", null);
    const old = new Date(NOW - 4 * DAY);
    for (const f of await readdir(dir)) await utimes(path.join(dir, f), old, old);
    const fresh = await call("crashed_02", null);
    const recent = new Date(NOW - 1000);
    for (const f of await readdir(fresh)) await utimes(path.join(fresh, f), recent, recent);
    const r = await sweepRecordings({ root, nowMs: NOW, isBusy: () => false });
    expect(r.deletedIds).toEqual(["crashed_01"]);
  });

  it("does not follow a junction out of the recordings folder", async () => {
    await writeCallMarker(outside, { id: "jumped_out", startedAt: new Date(NOW - 9 * DAY).toISOString(), endedAt: new Date(NOW - 9 * DAY).toISOString() });
    await symlink(outside, path.join(root, "jumped_out"), "junction");
    const r = await sweepRecordings({ root, nowMs: NOW, isBusy: () => false });
    expect(r.deleted).toBe(0);
    expect((await stat(outside)).isDirectory()).toBe(true);
  });

  it("a missing recordings folder is simply nothing to do", async () => {
    expect(await sweepRecordings({ root: path.join(root, "nope"), nowMs: NOW, isBusy: () => false }))
      .toMatchObject({ deleted: 0, kept: 0, busy: 0, notOurs: 0, errors: 0, deletedIds: [] });
  });

  it("the report has counts only — no names, no paths", async () => {
    await call("old_call_1", 4 * DAY);
    const r = await sweepRecordings({ root, nowMs: NOW, isBusy: () => false });
    const { deletedIds: _ids, ...forLog } = r;
    expect(JSON.stringify(forLog)).not.toContain("old_call_1");
    expect(JSON.stringify(forLog)).not.toContain(root);
  });
});

describe("call marker", () => {
  it("round-trips and can be updated with the end time", async () => {
    const dir = path.join(root, "sess_12345678");
    await mkdir(dir);
    await writeCallMarker(dir, { id: "sess_12345678", startedAt: "2026-10-26T02:00:00.000Z", endedAt: null });
    expect(await readCallMarker(dir)).toEqual({ app: "ta-call-recorder", id: "sess_12345678", started_at: "2026-10-26T02:00:00.000Z", ended_at: null });
    await writeCallMarker(dir, { id: "sess_12345678", startedAt: "2026-10-26T02:00:00.000Z", endedAt: "2026-10-26T02:10:00.000Z" });
    expect((await readCallMarker(dir))!.ended_at).toBe("2026-10-26T02:10:00.000Z");
  });
});
