import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverLeftovers } from "../../src/main/recovery";

const ID = "20261029-140305-a1b2c3";
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tacr-recover-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function leftover(id: string, parts: Record<string, string>, meta?: object) {
  const dir = join(root, ".in-progress", id);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(parts)) await writeFile(join(dir, name), content);
  if (meta) await writeFile(join(dir, `${id}.call.json`), JSON.stringify(meta));
  return dir;
}

describe("recoverLeftovers", () => {
  it("turns leftover chunks from a crash into a finished recording marked recovered", async () => {
    const dir = await leftover(
      ID,
      { [`${ID}.webm.part`]: "SSS", [`${ID}.left.webm.part`]: "LL", [`${ID}.right.webm.part`]: "RR" },
      { schema: 1, call_id: ID, status: "recording", started_at: "2026-10-29T07:03:05.000Z", recovered: false, pause_handling: "cut", pauses: [{ at_recorded_ms: 1000, paused_at: "2026-10-29T07:03:06.000Z", resumed_at: null }] },
    );
    const lastWrite = new Date("2026-10-29T07:20:00.000Z");
    const earlier = new Date("2026-10-29T07:19:59.000Z");
    await utimes(join(dir, `${ID}.webm.part`), lastWrite, lastWrite);
    await utimes(join(dir, `${ID}.left.webm.part`), earlier, earlier);
    await utimes(join(dir, `${ID}.right.webm.part`), earlier, earlier);

    const result = await recoverLeftovers(root);

    expect(result.recovered).toEqual([{ callId: ID, folder: join(root, ID) }]);
    expect((await readdir(join(root, ID))).sort()).toEqual([`${ID}.call.json`, `${ID}.left.webm`, `${ID}.right.webm`, `${ID}.webm`]);
    expect(await readFile(join(root, ID, `${ID}.webm`), "utf8")).toBe("SSS");
    const meta = JSON.parse(await readFile(join(root, ID, `${ID}.call.json`), "utf8"));
    expect(meta).toMatchObject({ status: "recovered", recovered: true, started_at: "2026-10-29T07:03:05.000Z", ended_at: "2026-10-29T07:20:00.000Z" });
    expect(meta.pauses[0].resumed_at).toBeNull();
    expect(existsSync(join(root, ".in-progress", ID))).toBe(false);
  });

  it("recovers even when the metadata was never written", async () => {
    await leftover(ID, { [`${ID}.webm.part`]: "S", [`${ID}.left.webm.part`]: "", [`${ID}.right.webm.part`]: "" });
    const result = await recoverLeftovers(root);
    expect(result.recovered.map((r) => r.callId)).toEqual([ID]);
    const meta = JSON.parse(await readFile(join(root, ID, `${ID}.call.json`), "utf8"));
    expect(meta).toMatchObject({ call_id: ID, status: "recovered", recovered: true, started_at: null });
  });

  it("drops a leftover that holds no audio at all", async () => {
    await leftover(ID, { [`${ID}.webm.part`]: "", [`${ID}.left.webm.part`]: "", [`${ID}.right.webm.part`]: "" });
    const result = await recoverLeftovers(root);
    expect(result.recovered).toEqual([]);
    expect(result.discardedEmpty).toBe(1);
    expect(existsSync(join(root, ".in-progress", ID))).toBe(false);
    expect(existsSync(join(root, ID))).toBe(false);
  });

  it("leaves folders it did not create alone", async () => {
    await mkdir(join(root, ".in-progress", "not a call"), { recursive: true });
    await writeFile(join(root, ".in-progress", "not a call", "x.webm.part"), "x");
    const result = await recoverLeftovers(root);
    expect(result.recovered).toEqual([]);
    expect(existsSync(join(root, ".in-progress", "not a call", "x.webm.part"))).toBe(true);
  });

  it("does not overwrite a finished call with the same id; it reports the clash", async () => {
    await leftover(ID, { [`${ID}.webm.part`]: "S" });
    await mkdir(join(root, ID));
    const result = await recoverLeftovers(root);
    expect(result.recovered).toEqual([]);
    expect(result.failed).toEqual([ID]);
    expect(existsSync(join(root, ".in-progress", ID, `${ID}.webm.part`))).toBe(true);
  });

  it("does nothing (and creates nothing) when the folder does not exist yet", async () => {
    const missing = join(root, "nope");
    const result = await recoverLeftovers(missing);
    expect(result).toEqual({ recovered: [], discardedEmpty: 0, failed: [] });
    expect(existsSync(missing)).toBe(false);
  });

  it("skips the call that is being recorded right now", async () => {
    await leftover(ID, { [`${ID}.webm.part`]: "S" });
    const result = await recoverLeftovers(root, { skipCallId: ID });
    expect(result.recovered).toEqual([]);
    expect(existsSync(join(root, ".in-progress", ID))).toBe(true);
  });
});
