import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JobQueue, QueueRunner, type NewJob, type StepOutcome, type SendOutcome } from "../../src/core/queue";

const T0 = Date.parse("2026-10-26T02:00:00Z");
const UPLOAD_TICKET = "U".repeat(43);

let dir: string;
let file: string;
let now: number;
const clock = () => now;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tcr-queue-"));
  file = path.join(dir, "queue.json");
  now = T0;
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const job = (id: string, over: Partial<NewJob> = {}): NewJob => ({
  id, sessionId: id, dialMode: "3cx", folder: `C:\\Rec\\${id}`,
  startedAt: "2026-10-26T09:00:00+07:00", endedAt: "2026-10-26T09:10:00+07:00",
  sendBy: "2026-10-29T02:00:00.000Z", ...over,
});

describe("JobQueue — the file", () => {
  it("starts empty, adds jobs at 'recorded' and persists them", async () => {
    const q = await JobQueue.open(file, { now: clock });
    expect(q.list()).toEqual([]);
    await q.add(job("sess_aaaa1111"));
    const again = await JobQueue.open(file, { now: clock });
    expect(again.list().map((j) => [j.id, j.stage])).toEqual([["sess_aaaa1111", "recorded"]]);
  });

  it("refuses a duplicate id or an unsafe id", async () => {
    const q = await JobQueue.open(file, { now: clock });
    await q.add(job("sess_aaaa1111"));
    await expect(q.add(job("sess_aaaa1111"))).rejects.toThrow();
    await expect(q.add(job("../x"))).rejects.toThrow();
  });

  it("resumes after a restart: work in progress goes back one step", async () => {
    const q = await JobQueue.open(file, { now: clock });
    await q.add(job("a_transcribing"));
    await q.add(job("b_sending"));
    await q.setStage("a_transcribing", "transcribing");
    await q.setStage("b_sending", "transcribed");
    await q.setStage("b_sending", "sending");
    const after = await JobQueue.open(file, { now: clock });
    expect(after.get("a_transcribing")!.stage).toBe("recorded");
    expect(after.get("b_sending")!.stage).toBe("transcribed");
  });

  it("writes atomically (no temp file left) and survives a damaged file", async () => {
    const q = await JobQueue.open(file, { now: clock });
    await q.add(job("sess_aaaa1111"));
    expect(await readdir(dir)).toEqual(["queue.json"]);
    await writeFile(file, "{ half a fi");
    const r = await JobQueue.open(file, { now: clock });
    expect(r.list()).toEqual([]);
    expect(r.recoveredFromDamage).toBe(true);
    expect((await readdir(dir)).some((f) => f.startsWith("queue.json.damaged-"))).toBe(true);
  });

  it("retry() puts a failed job back where it failed", async () => {
    const q = await JobQueue.open(file, { now: clock });
    await q.add(job("sess_aaaa1111"));
    await q.fail("sess_aaaa1111", "no_gemini_key");
    expect(q.get("sess_aaaa1111")).toMatchObject({ stage: "failed", failure: { reason: "no_gemini_key", stage: "recorded" } });
    await q.retry("sess_aaaa1111");
    expect(q.get("sess_aaaa1111")).toMatchObject({ stage: "recorded", failure: null, attempts: 0 });
  });

  it("forget() drops jobs whose recording folder was deleted, counting the unsent ones", async () => {
    const q = await JobQueue.open(file, { now: clock });
    await q.add(job("a_sent1234"));
    await q.add(job("b_waiting1"));
    await q.setStage("a_sent1234", "transcribed");
    await q.setStage("a_sent1234", "sending");
    await q.setStage("a_sent1234", "sent");
    expect(await q.forget(["a_sent1234", "b_waiting1", "unknown_1"])).toEqual({ removed: 2, unsent: 1 });
    expect(q.list()).toEqual([]);
  });
});

function runnerWith(q: JobQueue, o: {
  transcribe?: (id: string) => Promise<StepOutcome>;
  send?: (id: string, ticket: string) => Promise<SendOutcome>;
  ticket?: string | null;
}) {
  const log: string[] = [];
  const forgotten: string[] = [];
  const runner = new QueueRunner({
    queue: q,
    now: clock,
    random: () => 0.5,
    transcribe: async (j) => { log.push(`transcribe ${j.id}`); return o.transcribe ? o.transcribe(j.id) : { ok: true }; },
    send: async (j, t) => { log.push(`send ${j.id}`); return o.send ? o.send(j.id, t) : { ok: true, callId: `call_${j.id}`, duplicate: false }; },
    getUploadTicket: async () => (o.ticket === undefined ? UPLOAD_TICKET : o.ticket),
    forgetUploadTicket: async (id) => { forgotten.push(id); },
  });
  return { runner, log, forgotten };
}

describe("QueueRunner", () => {
  it("takes a call through every stage to 'sent', one job at a time, oldest first", async () => {
    const q = await JobQueue.open(file, { now: clock });
    await q.add(job("a_first111"));
    await q.add(job("b_second11"));
    const { runner, log, forgotten } = runnerWith(q, {});
    await runner.drain();
    expect(log).toEqual(["transcribe a_first111", "send a_first111", "transcribe b_second11", "send b_second11"]);
    expect(q.get("a_first111")).toMatchObject({ stage: "sent", callId: "call_a_first111" });
    expect(forgotten).toEqual(["a_first111", "b_second11"]);
  });

  it("a call without a session ends 'local_only' and is never sent (D-82)", async () => {
    const q = await JobQueue.open(file, { now: clock });
    await q.add(job("local_1234", { sessionId: null, dialMode: null, sendBy: null }));
    const { runner, log } = runnerWith(q, {});
    await runner.drain();
    expect(q.get("local_1234")!.stage).toBe("local_only");
    expect(log).toEqual(["transcribe local_1234"]);
  });

  it("never writes the upload ticket into the queue file", async () => {
    const q = await JobQueue.open(file, { now: clock });
    await q.add(job("sess_aaaa1111"));
    let seen = "";
    const { runner } = runnerWith(q, { send: async (_id, t) => { seen = t; return { ok: false, retryable: true, retryAfterMs: null }; } });
    await runner.drain();
    expect(seen).toBe(UPLOAD_TICKET);
    expect(await readFile(file, "utf8")).not.toContain(UPLOAD_TICKET);
  });

  it("retries with growing backoff and honours the server's wait", async () => {
    const q = await JobQueue.open(file, { now: clock });
    await q.add(job("sess_aaaa1111"));
    let n = 0;
    const { runner, log } = runnerWith(q, { transcribe: async () => (++n < 3 ? { ok: false, retryable: true, retryAfterMs: n === 2 ? 600_000 : null } : { ok: true }) });
    await runner.drain();
    expect(q.get("sess_aaaa1111")).toMatchObject({ stage: "recorded", attempts: 1 });
    expect(Date.parse(q.get("sess_aaaa1111")!.nextAttemptAt!) - now).toBe(30_000);
    expect(q.nextWakeAt()).toBe(now + 30_000);
    await runner.drain(); // not due yet: nothing happens
    expect(log).toHaveLength(1);
    now += 30_000;
    await runner.drain();
    expect(Date.parse(q.get("sess_aaaa1111")!.nextAttemptAt!) - now).toBe(600_000); // Retry-After beats the 60 s backoff
    now += 600_000;
    await runner.drain();
    expect(q.get("sess_aaaa1111")!.stage).toBe("sent");
  });

  it("a final failure stops the job with its reason", async () => {
    const q = await JobQueue.open(file, { now: clock });
    await q.add(job("sess_aaaa1111"));
    const { runner } = runnerWith(q, { transcribe: async () => ({ ok: false, retryable: false, reason: "gemini_key_rejected" }) });
    await runner.drain();
    expect(q.get("sess_aaaa1111")).toMatchObject({ stage: "failed", failure: { reason: "gemini_key_rejected", stage: "recorded" } });
  });

  it("a send refused for good fails the job and forgets the ticket; details are kept", async () => {
    const q = await JobQueue.open(file, { now: clock });
    await q.add(job("sess_aaaa1111"));
    const { runner, forgotten } = runnerWith(q, { send: async () => ({ ok: false, retryable: false, reason: "solace_different_content" }) });
    await runner.drain();
    expect(q.get("sess_aaaa1111")).toMatchObject({ stage: "failed", failure: { reason: "solace_different_content", stage: "transcribed" } });
    expect(forgotten).toEqual(["sess_aaaa1111"]);
  });

  it("no upload ticket in secure storage → failed, nothing sent", async () => {
    const q = await JobQueue.open(file, { now: clock });
    await q.add(job("sess_aaaa1111"));
    const { runner, log } = runnerWith(q, { ticket: null });
    await runner.drain();
    expect(q.get("sess_aaaa1111")).toMatchObject({ stage: "failed", failure: { reason: "upload_ticket_missing" } });
    expect(log).toEqual(["transcribe sess_aaaa1111"]);
  });

  it("past the 72 h send-by time → failed, nothing sent (D-144)", async () => {
    const q = await JobQueue.open(file, { now: clock });
    await q.add(job("sess_aaaa1111", { sendBy: new Date(T0 - 1).toISOString() }));
    const { runner, log } = runnerWith(q, {});
    await runner.drain();
    expect(q.get("sess_aaaa1111")).toMatchObject({ stage: "failed", failure: { reason: "upload_window_closed" } });
    expect(log).toEqual(["transcribe sess_aaaa1111"]);
  });

  it("an exception in a step is retried, then fails after a few tries", async () => {
    const q = await JobQueue.open(file, { now: clock });
    await q.add(job("sess_aaaa1111"));
    const { runner } = runnerWith(q, { transcribe: async () => { throw new Error("decoder crashed"); } });
    for (let i = 0; i < 10; i++) { await runner.drain(); now += 3_600_000; }
    expect(q.get("sess_aaaa1111")).toMatchObject({ stage: "failed", failure: { reason: "unexpected_error" } });
  });

  it("drain() called twice at once runs the work once", async () => {
    const q = await JobQueue.open(file, { now: clock });
    await q.add(job("sess_aaaa1111"));
    const { runner, log } = runnerWith(q, {});
    await Promise.all([runner.drain(), runner.drain()]);
    expect(log).toEqual(["transcribe sess_aaaa1111", "send sess_aaaa1111"]);
  });

  it("isBusy() is true only while a job is being transcribed or sent", async () => {
    const q = await JobQueue.open(file, { now: clock });
    await q.add(job("sess_aaaa1111"));
    let during = false;
    const { runner } = runnerWith(q, { transcribe: async (id) => { during = q.isBusy(id); return { ok: true }; } });
    expect(q.isBusy("sess_aaaa1111")).toBe(false);
    await runner.drain();
    expect(during).toBe(true);
    expect(q.isBusy("sess_aaaa1111")).toBe(false);
  });
});
