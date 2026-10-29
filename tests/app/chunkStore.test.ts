import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallWriter } from "../../src/main/chunkStore";

const ID = "20261029-140305-a1b2c3";
const MIC = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tacr-store-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const bytes = (s: string) => new TextEncoder().encode(s);

async function begin() {
  return CallWriter.begin({ root, callId: ID, startedAt: new Date("2026-10-29T07:03:05.000Z"), micProcessing: MIC, appVersion: "0.1.0" });
}

describe("CallWriter", () => {
  it("starts a call in the in-progress folder with empty part files and metadata", async () => {
    await begin();
    const dir = join(root, ".in-progress", ID);
    expect((await readdir(dir)).sort()).toEqual([`${ID}.call.json`, `${ID}.left.webm.part`, `${ID}.right.webm.part`, `${ID}.webm.part`]);
    const meta = JSON.parse(await readFile(join(dir, `${ID}.call.json`), "utf8"));
    expect(meta).toMatchObject({ call_id: ID, status: "recording", started_at: "2026-10-29T07:03:05.000Z", recovered: false, pause_handling: "cut", pauses: [], mic_processing: MIC });
  });

  it("appends chunks in the order they were sent, even without awaiting each one", async () => {
    const w = await begin();
    const writes = ["a", "b", "c", "d", "e"].map((s) => w.append("stereo", bytes(s)));
    w.append("left", bytes("L1"));
    await Promise.all(writes);
    await w.flush();
    expect(await readFile(join(root, ".in-progress", ID, `${ID}.webm.part`), "utf8")).toBe("abcde");
    expect(await readFile(join(root, ".in-progress", ID, `${ID}.left.webm.part`), "utf8")).toBe("L1");
  });

  it("records pause marks in the metadata as they happen", async () => {
    const w = await begin();
    await w.markPause({ kind: "pause", at: new Date("2026-10-29T07:05:00.000Z"), recordedMs: 115000 });
    await w.markPause({ kind: "resume", at: new Date("2026-10-29T07:06:00.000Z"), recordedMs: 115000 });
    const meta = JSON.parse(await readFile(join(root, ".in-progress", ID, `${ID}.call.json`), "utf8"));
    expect(meta.pauses).toEqual([{ at_recorded_ms: 115000, paused_at: "2026-10-29T07:05:00.000Z", resumed_at: "2026-10-29T07:06:00.000Z" }]);
  });

  it("on Stop moves the files to final names in a per-call folder", async () => {
    const w = await begin();
    w.append("stereo", bytes("S"));
    w.append("left", bytes("L"));
    w.append("right", bytes("R"));
    const result = await w.finalise({ endedAt: new Date("2026-10-29T07:13:05.000Z"), recordedMs: 540000 });
    const dir = join(root, ID);
    expect(result.folder).toBe(dir);
    expect((await readdir(dir)).sort()).toEqual([`${ID}.call.json`, `${ID}.left.webm`, `${ID}.right.webm`, `${ID}.webm`]);
    expect(await readFile(join(dir, `${ID}.right.webm`), "utf8")).toBe("R");
    expect(existsSync(join(root, ".in-progress", ID))).toBe(false);
    const meta = JSON.parse(await readFile(join(dir, `${ID}.call.json`), "utf8"));
    expect(meta).toMatchObject({ status: "complete", ended_at: "2026-10-29T07:13:05.000Z", recorded_ms: 540000, recovered: false });
  });

  it("refuses writes after Stop", async () => {
    const w = await begin();
    await w.finalise({ endedAt: new Date(), recordedMs: 0 });
    await expect(w.append("stereo", bytes("late"))).rejects.toThrow(/finished/);
  });

  it("never overwrites an existing call folder", async () => {
    await mkdir(join(root, ID));
    await writeFile(join(root, ID, "keep.txt"), "x");
    const w = await begin();
    await expect(w.finalise({ endedAt: new Date(), recordedMs: 0 })).rejects.toThrow(/already exists/);
    expect(await readFile(join(root, ID, "keep.txt"), "utf8")).toBe("x");
    expect(existsSync(join(root, ".in-progress", ID))).toBe(true);
  });

  it("abort removes a call that never recorded anything", async () => {
    const w = await begin();
    await w.abort();
    expect(existsSync(join(root, ".in-progress", ID))).toBe(false);
  });

  it("refuses an unsafe call id", async () => {
    await expect(CallWriter.begin({ root, callId: "../evil", startedAt: new Date(), micProcessing: MIC, appVersion: "0.1.0" })).rejects.toThrow(/call id/);
  });
});
