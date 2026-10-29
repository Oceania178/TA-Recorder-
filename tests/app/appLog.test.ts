import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLog, sanitiseFields } from "../../src/main/appLog";

const TICKET = "Abc_def-ghi1234567890Abc_def-ghi1234567890x"; // 43 chars, like Solace's tickets
const SESSION = "cmh2x9k0a0001qz8v7y6t5r4e";

describe("log redaction", () => {
  it("keeps numbers, booleans and short lowercase codes", () => {
    expect(sanitiseFields({ deleted: 3, ok: true, stage: "transcribed", reason: "no_gemini_key", none: null })).toEqual({
      deleted: 3, ok: true, stage: "transcribed", reason: "no_gemini_key", none: null,
    });
  });

  it("keeps a call id under the key 'id' only", () => {
    expect(sanitiseFields({ id: "20261029-140305-a1b2c3" })).toEqual({ id: "20261029-140305-a1b2c3" });
    expect(sanitiseFields({ id: SESSION })).toEqual({ id: SESSION });
    expect(sanitiseFields({ code: SESSION })).toEqual({ code: "[redacted]" });
  });

  it("never keeps a ticket, a key, a URL, a path or text", () => {
    const out = sanitiseFields({
      id: TICKET,
      ticket: TICKET,
      key: "AIzaSyFAKEFAKEFAKEFAKE",
      url: `tacallrecorder://start?session_id=${SESSION}&ticket=${TICKET}&dial_mode=3cx`,
      folder: "C:\\Users\\ta\\Documents\\Sound Recordings\\TA Call Recorder\\x",
      text: "Xin chào, tôi là Lan",
      err: new Error(`failed with ${TICKET}`),
      nested: { ticket: TICKET },
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain(TICKET);
    expect(json).not.toContain("AIza");
    expect(json).not.toContain("tacallrecorder");
    expect(json).not.toContain("Users");
    expect(json).not.toContain("chào");
    expect(Object.values(out).every((v) => v === "[redacted]")).toBe(true);
  });

  it("drops keys that are not plain names", () => {
    expect(sanitiseFields({ [`x${TICKET}`]: 1, "a b": 2, ok: 1 })).toEqual({ ok: 1 });
  });
});

describe("AppLog file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tacr-log-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes one line per event with the time, the event and the cleaned fields", async () => {
    const log = new AppLog({ file: join(dir, "app.log"), now: () => new Date("2026-10-29T10:00:00Z") });
    log.event("sweep", { deleted: 2, kept: 1 });
    log.event("link.refused", { reason: "refused", ticket: TICKET });
    log.event(`bad event ${TICKET}`, {});
    await log.flush();
    const lines = (await readFile(join(dir, "app.log"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('2026-10-29T10:00:00.000Z sweep {"deleted":2,"kept":1}');
    expect(lines[1]).toContain('"ticket":"[redacted]"');
    expect(lines[2]).toContain("invalid_event");
    expect(lines.join("\n")).not.toContain(TICKET);
  });

  it("starts a new file when the log grows too big, keeping one old file", async () => {
    const file = join(dir, "app.log");
    await writeFile(file, "x".repeat(2000));
    const log = new AppLog({ file, maxBytes: 1000 });
    log.event("start", {});
    await log.flush();
    expect((await stat(file)).size).toBeLessThan(200);
    expect((await stat(`${file}.1`)).size).toBe(2000);
  });
});
