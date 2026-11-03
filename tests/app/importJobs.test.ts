// D-171: an imported call in the queue. A stereo import goes exactly like a live call; a mono one is transcribed
// with speaker labels and waits for the TA's voice choice, then it is sent (or ends Local only).
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeCallMarker, type FetchLike, type RequestInitLike } from "../../src/core";
import { DIARIZE_PROMPT } from "../../src/core/diarize";
import { CallJobs, type CallJobsDeps } from "../../src/main/callJobs";
import { deletePcmFiles, floatToInt16, makeOpenMono, makeOpenPcm, pcmPaths } from "../../src/main/pcmFiles";

const KEY = "AIzaFAKE-import-key";
const SOLACE = "https://solace.test";
const SID = "sess-import-mono-01";
const T0 = Date.parse("2026-11-01T02:10:00Z");

let base: string;
let jobs: CallJobs | null;
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), "tacr-import-jobs-")); jobs = null; });
afterEach(async () => { jobs?.close(); await rm(base, { recursive: true, force: true }); });

async function s16(file: string, seconds: number): Promise<void> {
  const pcm = Float32Array.from({ length: seconds * 16_000 }, (_, i) => Math.sin(i / 9) * 0.3);
  const ints = floatToInt16(pcm);
  await writeFile(file, new Uint8Array(ints.buffer));
}

async function importFolder(id: string, audio: "mono" | "stereo"): Promise<string> {
  const folder = join(base, "rec", id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${id}.import.m4a`), "m4a");
  if (audio === "mono") await s16(join(folder, `${id}.mono.s16`), 20);
  else {
    await s16(join(folder, `${id}.left.s16`), 3);
    await s16(join(folder, `${id}.right.s16`), 3);
  }
  await writeCallMarker(folder, { id, startedAt: new Date(T0).toISOString(), endedAt: new Date(T0 + 86_400_000).toISOString() });
  return folder;
}

function net() {
  const prompts: string[] = [];
  const solace: RequestInitLike[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      const body = JSON.parse(String(init.body));
      const prompt = body.contents[0].parts[0].text as string;
      prompts.push(prompt === DIARIZE_PROMPT ? "diarize" : "plain");
      const text = prompt === DIARIZE_PROMPT ? "A 00:00 | Chào em\nB 00:03 | Dạ em mong 35 triệu" : "xin chào";
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }) };
    }
    solace.push(init);
    return { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ call_id: "call_imp" }) };
  };
  return { fetch, prompts, solace };
}

function deps(fetch: FetchLike, over: Partial<CallJobsDeps> = {}): CallJobsDeps {
  const decodeNothing = async () => { throw new Error("no webm here"); };
  return {
    queueFile: join(base, "userData", "queue.json"),
    secrets: {
      getGeminiKey: async () => KEY,
      getTicket: async () => "U".repeat(43),
      heldTicket: async () => ({ origin: SOLACE }),
      forgetTicket: async () => undefined,
    },
    getBaseUrl: () => SOLACE,
    getModel: () => "gemini-x",
    fetch,
    openPcm: makeOpenPcm(decodeNothing),
    openMono: makeOpenMono(),
    afterTranscript: (job) => deletePcmFiles(job.folder, job.id),
    appVersion: "0.1.5",
    geminiSleep: async () => undefined,
    geminiMaxAttempts: 1,
    tzOffsetMinutes: () => 420,
    setTimer: () => 0,
    clearTimer: () => undefined,
    ...over,
  };
}

const session = { sessionId: SID, dialMode: "self_dial" as const, sendBy: "2099-01-01T00:00:00.000Z" };

describe("CallJobs with imported calls", () => {
  it("a stereo import is transcribed from its decoded files and sent like a live call", async () => {
    const n = net();
    jobs = await CallJobs.open(deps(n.fetch));
    const folder = await importFolder("sess-import-st-01", "stereo");
    await jobs.add({ id: "sess-import-st-01", folder, startedAtMs: T0, endedAtMs: T0 + 3000, session: { ...session, sessionId: "sess-import-st-01" }, audio: "stereo", imported: true });
    expect(jobs.get("sess-import-st-01")).toMatchObject({ stage: "sent", imported: true });
    expect(n.prompts.every((p) => p === "plain")).toBe(true);
    expect(JSON.parse(String(n.solace[0].body)).call.started_at).toBe("2026-11-01T09:10:00+07:00");
    expect(existsSync(pcmPaths(folder, "sess-import-st-01").left)).toBe(false); // temp audio deleted after the transcript
  });

  it("a mono import waits for the voice choice; then it is sent with ta / candidate", async () => {
    const n = net();
    jobs = await CallJobs.open(deps(n.fetch));
    const folder = await importFolder(SID, "mono");
    await jobs.add({ id: SID, folder, startedAtMs: T0, endedAtMs: T0 + 20_000, session, audio: "mono", imported: true });
    expect(jobs.get(SID)).toMatchObject({ stage: "transcribed", speakersNeeded: true, audio: "mono" });
    expect(n.prompts).toEqual(["diarize"]);
    expect(n.solace).toHaveLength(0);

    const preview = await jobs.speakerPreview(SID);
    expect(preview?.chunks[0].turns.map((t) => [t.label, t.text])).toEqual([["A", "Chào em"], ["B", "Dạ em mong 35 triệu"]]);

    expect(await jobs.chooseSpeakers(SID, { me: "A", swapped: [] })).toBe(true);
    expect(jobs.get(SID)).toMatchObject({ stage: "sent", speakersNeeded: false });
    const body = JSON.parse(String(n.solace[0].body));
    expect(body.transcript.segments.map((t: { speaker: string }) => t.speaker)).toEqual(["ta", "candidate"]);
    expect(body.call.has_content).toBe(true);
    expect(existsSync(join(folder, `${SID}.mono.s16`))).toBe(false);
  });

  it("a choice is refused for a call that does not wait for one, or with a wrong answer", async () => {
    const n = net();
    jobs = await CallJobs.open(deps(n.fetch));
    expect(await jobs.chooseSpeakers("nope-000001", { me: "A", swapped: [] })).toBe(false);
    const folder = await importFolder(SID, "mono");
    await jobs.add({ id: SID, folder, startedAtMs: T0, endedAtMs: T0 + 20_000, session, audio: "mono", imported: true });
    expect(await jobs.chooseSpeakers(SID, { me: "C" as "A", swapped: [] })).toBe(false);
    expect(jobs.get(SID)?.speakersNeeded).toBe(true);
  });
});

describe("pcmFiles for imports", () => {
  it("makeOpenPcm uses already decoded files when there is no WebM (a stereo import)", async () => {
    const folder = await importFolder("sess-import-st-02", "stereo");
    const src = await makeOpenPcm(async () => { throw new Error("must not decode"); })({ id: "sess-import-st-02", folder } as never);
    expect(src?.left.length).toBe(48_000);
    await src?.close?.();
  });

  it("makeOpenMono reads <id>.mono.s16, or decodes the import copy again when it is gone (a retry)", async () => {
    const folder = await importFolder("sess-import-mo-03", "mono");
    const r = await makeOpenMono()({ id: "sess-import-mo-03", folder } as never);
    expect(r?.length).toBe(320_000);
    await r?.close?.();
    await deletePcmFiles(folder, "sess-import-mo-03");
    expect(existsSync(join(folder, "sess-import-mo-03.mono.s16"))).toBe(false);
    const seen: string[] = [];
    const again = await makeOpenMono(async (file, outDir, id) => { seen.push(file); await s16(join(outDir, `${id}.mono.s16`), 1); })({ id: "sess-import-mo-03", folder } as never);
    expect(seen).toEqual([join(folder, "sess-import-mo-03.import.m4a")]);
    expect(again?.length).toBe(16_000);
    await again?.close?.();
    expect(await makeOpenMono()({ id: "missing-00001", folder: join(base, "none") } as never)).toBeNull();
  });
});
