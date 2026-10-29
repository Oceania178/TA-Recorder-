// After Stop: the job queue, the runner, the Gemini key, the upload ticket, the timer and retention, wired together.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallJobs, type CallJobsDeps, type SavedCall } from "../../src/main/callJobs";
import { JobQueue, writeCallMarker, type FetchLike, type RequestInitLike } from "../../src/core";
import { build } from "../core/signals";

const SR = 16_000;
const KEY = "AIzaFAKE-wiring-key";
const SOLACE = "https://solace.test";
const UPLOAD_TICKET = "U".repeat(43);
const SID = "cmh2x9k0a0001qz8v7y6t5r4e";
const LOCAL_ID = "20261029-100000-a1b2c3";
const T0 = Date.parse("2026-10-29T03:00:00Z");

const left = build(SR, [{ kind: "silence", ms: 500 }, { kind: "tone", ms: 1500 }, { kind: "silence", ms: 1000 }], 1);
const right = build(SR, [{ kind: "silence", ms: 2000 }, { kind: "noise", ms: 1000 }], 2);

interface Seen { url: string; init: RequestInitLike }

function fakeNet(o: { geminiStatus?: () => number } = {}) {
  const gemini: Seen[] = [];
  const solace: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      gemini.push({ url, init });
      const status = o.geminiStatus?.() ?? 200;
      if (status !== 200) return { status, headers: { get: () => null }, text: async () => "" };
      const body = { candidates: [{ content: { parts: [{ text: "xin chào" }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 5 } };
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    }
    if (url.startsWith(SOLACE)) {
      solace.push({ url, init });
      return { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ call_id: "call_1" }) };
    }
    throw new Error("unexpected address");
  };
  return { fetch, gemini, solace };
}

let base: string;
let recordings: string;
let now: number;
let key: string | null;
let tickets: Map<string, string>;
let forgotten: string[];
let ticketReads: string[];
let cleaned: string[];
let timers: { fn: () => void; ms: number; cleared: boolean }[];
let logs: string[];
let jobs: CallJobs | null;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "tacr-jobs-"));
  recordings = join(base, "recordings");
  await mkdir(join(base, "userData"), { recursive: true });
  now = T0 + 60_000;
  key = KEY;
  tickets = new Map([[SID, UPLOAD_TICKET]]);
  forgotten = [];
  ticketReads = [];
  cleaned = [];
  timers = [];
  logs = [];
  jobs = null;
});
afterEach(async () => {
  jobs?.close();
  await rm(base, { recursive: true, force: true });
});

async function callFolder(id: string, endedAtMs = T0 + 3000): Promise<string> {
  const folder = join(recordings, id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${id}.left.webm`), "L");
  await writeFile(join(folder, `${id}.right.webm`), "R");
  await writeCallMarker(folder, { id, startedAt: new Date(T0).toISOString(), endedAt: new Date(endedAtMs).toISOString() });
  return folder;
}

function deps(fetch: FetchLike, over: Partial<CallJobsDeps> = {}): CallJobsDeps {
  return {
    queueFile: join(base, "userData", "queue.json"),
    secrets: {
      getGeminiKey: async () => key,
      getTicket: async (id) => {
        ticketReads.push(id);
        return tickets.get(id) ?? null;
      },
      heldTicket: async (id) => (tickets.has(id) ? { origin: SOLACE } : null),
      forgetTicket: async (id) => {
        forgotten.push(id);
        tickets.delete(id);
      },
    },
    getBaseUrl: () => SOLACE,
    getModel: () => "gemini-3.5-transcribe",
    fetch,
    loadPcm: async () => ({ left, right, sampleRate: SR }),
    afterTranscript: async (job) => void cleaned.push(job.id),
    appVersion: "0.1.0",
    now: () => now,
    random: () => 0.5,
    geminiSleep: async () => undefined,
    geminiMaxAttempts: 1,
    tzOffsetMinutes: () => 420,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => void ((h as { cleared: boolean }).cleared = true),
    log: (event, fields) => void logs.push(`${event} ${JSON.stringify(fields)}`),
    ...over,
  };
}

const linkedCall = (folder: string): SavedCall => ({
  id: SID, folder, startedAtMs: T0, endedAtMs: T0 + 3000,
  session: { sessionId: SID, dialMode: "3cx", sendBy: new Date(T0 + 72 * 3600_000).toISOString() },
});
const localCall = (folder: string): SavedCall => ({ id: LOCAL_ID, folder, startedAtMs: T0, endedAtMs: T0 + 3000, session: null });

describe("CallJobs: after Stop", () => {
  it("transcribes and sends a linked call right after Stop, then forgets the upload ticket", async () => {
    const net = fakeNet();
    jobs = await CallJobs.open(deps(net.fetch));
    await jobs.add(linkedCall(await callFolder(SID)));
    expect(jobs.list()[0]).toMatchObject({ id: SID, stage: "sent", callId: "call_1" });
    expect(net.gemini.length).toBeGreaterThan(0);
    expect(net.gemini[0].init.headers["x-goog-api-key"]).toBe(KEY);
    expect(net.solace).toHaveLength(1);
    expect(net.solace[0].init.headers.Authorization).toBe(`Bearer ${UPLOAD_TICKET}`);
    const body = JSON.parse(net.solace[0].init.body!);
    expect(body.call.started_at).toBe("2026-10-29T10:00:00+07:00");
    expect(body.call.dial_mode).toBe("3cx");
    expect(forgotten).toEqual([SID]);
    expect(cleaned).toEqual([SID]);
  });

  it("never sends a local-only call, and never asks for a ticket for it (D-82)", async () => {
    const net = fakeNet();
    jobs = await CallJobs.open(deps(net.fetch));
    const folder = await callFolder(LOCAL_ID);
    await jobs.add(localCall(folder));
    expect(jobs.list()[0]).toMatchObject({ id: LOCAL_ID, stage: "local_only", sessionId: null });
    expect(net.solace).toHaveLength(0);
    expect(ticketReads).toHaveLength(0);
    const files = await readdir(folder);
    expect(files).toContain(`${LOCAL_ID}.transcript.md`);
    expect(JSON.parse(await readFile(join(folder, `${LOCAL_ID}.transcript.json`), "utf8")).session_id).toBeNull();
    await jobs.drain();
    expect(net.solace).toHaveLength(0);
  });

  it("without a Gemini key the job waits in 'recorded' (not failed), then resumes when a key is added", async () => {
    key = null;
    const net = fakeNet();
    jobs = await CallJobs.open(deps(net.fetch));
    await jobs.add(linkedCall(await callFolder(SID)));
    expect(jobs.list()[0].stage).toBe("recorded");
    expect(jobs.waitingForKey()).toBe(true);
    expect(net.gemini).toHaveLength(0);
    key = KEY;
    await jobs.keyChanged();
    expect(jobs.list()[0].stage).toBe("sent");
    expect(jobs.waitingForKey()).toBe(false);
  });

  it("drains at start-up what an earlier run left waiting", async () => {
    const folder = await callFolder(SID);
    const q = await JobQueue.open(join(base, "userData", "queue.json"));
    await q.add({ id: SID, sessionId: SID, dialMode: "self_dial", folder, startedAt: "2026-10-29T10:00:00+07:00", endedAt: "2026-10-29T10:00:03+07:00", sendBy: new Date(T0 + 72 * 3600_000).toISOString() });
    const net = fakeNet();
    jobs = await CallJobs.open(deps(net.fetch));
    await jobs.drain();
    expect(jobs.list()[0].stage).toBe("sent");
  });

  it("waits for Gemini with a timer at the queue's next wake time, and the timer drains again", async () => {
    let geminiDown = true;
    const net = fakeNet({ geminiStatus: () => (geminiDown ? 503 : 200) });
    jobs = await CallJobs.open(deps(net.fetch));
    await jobs.add(linkedCall(await callFolder(SID)));
    expect(jobs.list()[0].stage).toBe("recorded");
    const live = timers.filter((t) => !t.cleared);
    expect(live).toHaveLength(1);
    const wake = Date.parse(jobs.list()[0].nextAttemptAt!);
    expect(live[0].ms).toBe(wake - now);
    geminiDown = false;
    now = wake + 1;
    live[0].fn();
    await jobs.idle();
    expect(jobs.list()[0].stage).toBe("sent");
  });

  it("retries a failed call on request", async () => {
    tickets.clear();
    const net = fakeNet();
    jobs = await CallJobs.open(deps(net.fetch));
    await jobs.add(linkedCall(await callFolder(SID)));
    expect(jobs.list()[0]).toMatchObject({ stage: "failed", failure: { reason: "upload_ticket_missing" } });
    tickets.set(SID, UPLOAD_TICKET);
    expect(await jobs.retry(SID)).toBe(true);
    expect(jobs.list()[0].stage).toBe("sent");
  });

  it("sweeps calls older than 3 days, forgets their jobs and tickets, and logs counts only", async () => {
    const net = fakeNet();
    jobs = await CallJobs.open(deps(net.fetch));
    await jobs.add(linkedCall(await callFolder(SID)));
    now = T0 + 4 * 24 * 3600_000;
    await callFolder(LOCAL_ID, now - 1000); // ended a second ago: kept
    tickets.set(SID, UPLOAD_TICKET);
    const r = await jobs.sweep(recordings);
    expect(r).toMatchObject({ deleted: 1, kept: 1 });
    expect(existsSync(join(recordings, SID))).toBe(false);
    expect(jobs.list()).toHaveLength(0);
    expect(tickets.has(SID)).toBe(false);
    const text = logs.join("\n");
    expect(text).toContain("retention.sweep");
    expect(text).not.toContain(recordings);
  });

  it("forgets jobs whose folder disappeared while the app was closed (the logon cleanup task)", async () => {
    await mkdir(recordings, { recursive: true }); // the recordings folder is there; only the call folder is gone
    const q = await JobQueue.open(join(base, "userData", "queue.json"));
    await q.add({ id: SID, sessionId: SID, dialMode: "3cx", folder: join(recordings, SID), startedAt: "2026-10-29T10:00:00+07:00", endedAt: "2026-10-29T10:00:03+07:00", sendBy: null });
    const net = fakeNet();
    jobs = await CallJobs.open(deps(net.fetch));
    expect(jobs.list()).toHaveLength(0);
    expect(forgotten).toEqual([SID]);
  });
});
