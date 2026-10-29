import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assembleTurns, hasContent, sanitiseTurnText, formatIsoWithOffset, buildTranscriptFile, toPayload,
  renderMarkdown, writeTranscriptFiles, readTranscriptFile, HAS_CONTENT_MIN_CANDIDATE_TURNS,
} from "../../src/core/transcript";
import { writeFileAtomic } from "../../src/core/atomicWrite";

describe("sanitiseTurnText — never a text Solace would refuse", () => {
  it("one line, no box-drawing characters, collapsed spaces", () => {
    const raw = ` a\r\nb\tc${String.fromCharCode(0x2028)}d ${String.fromCharCode(0x2500, 0x2500)} e `;
    expect(sanitiseTurnText(raw)).toBe("a b c d e");
  });
  it("breaks a run of more than 200 base64-like characters", () => {
    const out = sanitiseTurnText("x".repeat(450));
    expect(out.replace(/ /g, "")).toBe("x".repeat(450));
    expect(out.split(" ").every((w) => w.length <= 200)).toBe(true);
  });
});

describe("assembleTurns", () => {
  it("merges both channels in time order: left = ta, right = candidate; drops empty turns", () => {
    const turns = assembleTurns(
      [{ start_ms: 0, end_ms: 2000, text: "Chào bạn" }, { start_ms: 5000, end_ms: 6000, text: "  " }, { start_ms: 7000, end_ms: 9000, text: "Bạn ở đâu?" }],
      [{ start_ms: 2100, end_ms: 4000, text: "Dạ chào chị" }, { start_ms: 7000, end_ms: 7500, text: "Dạ" }],
    );
    expect(turns).toEqual([
      { speaker: "ta", start_ms: 0, end_ms: 2000, text: "Chào bạn" },
      { speaker: "candidate", start_ms: 2100, end_ms: 4000, text: "Dạ chào chị" },
      { speaker: "candidate", start_ms: 7000, end_ms: 7500, text: "Dạ" },
      { speaker: "ta", start_ms: 7000, end_ms: 9000, text: "Bạn ở đâu?" },
    ]);
  });

  it("gives whole, non-negative milliseconds with end ≥ start", () => {
    const [t] = assembleTurns([{ start_ms: 10.6, end_ms: 9.2, text: "x" }], []);
    expect(t).toEqual({ speaker: "ta", start_ms: 11, end_ms: 11, text: "x" });
  });
});

describe("hasContent (D-37: threshold not set yet)", () => {
  it("is true when the candidate has at least one turn with words", () => {
    expect(HAS_CONTENT_MIN_CANDIDATE_TURNS).toBe(1);
    expect(hasContent([{ speaker: "candidate", start_ms: 0, end_ms: 1, text: "Dạ" }])).toBe(true);
    expect(hasContent([{ speaker: "ta", start_ms: 0, end_ms: 1, text: "Alo alo?" }])).toBe(false);
    expect(hasContent([])).toBe(false);
  });
});

describe("formatIsoWithOffset", () => {
  it("writes local time with the zone", () => {
    const at = Date.parse("2026-10-26T02:00:00Z");
    expect(formatIsoWithOffset(at, 420)).toBe("2026-10-26T09:00:00+07:00");
    expect(formatIsoWithOffset(at, -330)).toBe("2026-10-25T20:30:00-05:30");
    expect(formatIsoWithOffset(at, 0)).toBe("2026-10-26T02:00:00+00:00");
  });
});

const started = Date.parse("2026-10-26T02:00:00Z");
const ended = started + 754_400;
const turns = [
  { speaker: "ta" as const, start_ms: 0, end_ms: 4000, text: "Chào bạn" },
  { speaker: "candidate" as const, start_ms: 4200, end_ms: 6000, text: "Dạ em chào chị" },
];

describe("buildTranscriptFile / toPayload (§8.24 ②)", () => {
  it("builds exactly the contract for a session call", () => {
    const file = buildTranscriptFile({
      sessionId: "cmh2x9k0a0001qz8v7y6t5r4e", dialMode: "3cx", startedAtMs: started, endedAtMs: ended, tzOffsetMinutes: 420,
      turns, model: "gemini-3.5-transcribe", appVersion: "0.1.0",
    });
    expect(toPayload(file)).toEqual({
      schema_version: 1,
      session_id: "cmh2x9k0a0001qz8v7y6t5r4e",
      call: { started_at: "2026-10-26T09:00:00+07:00", ended_at: "2026-10-26T09:12:34+07:00", duration_s: 754, dial_mode: "3cx", has_content: true },
      transcript: { segments: turns, model: "gemini-3.5-transcribe" },
      recorder: { app_version: "0.1.0" },
    });
  });

  it("a local-only call (no session, D-82) has no payload: it is never sent", () => {
    const file = buildTranscriptFile({ sessionId: null, dialMode: null, startedAtMs: started, endedAtMs: ended, tzOffsetMinutes: 420, turns, model: "m", appVersion: "0.1.0" });
    expect(file.session_id).toBeNull();
    expect(toPayload(file)).toBeNull();
  });
});

describe("files beside the audio (<id>.transcript.md and .json)", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "tcr-transcript-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const file = () => buildTranscriptFile({ sessionId: "sess_12345678", dialMode: "self_dial", startedAtMs: started, endedAtMs: ended, tzOffsetMinutes: 420, turns, model: "gemini-3.5-transcribe", appVersion: "0.1.0" });

  it("writes both files and reads the JSON back unchanged", async () => {
    await writeTranscriptFiles(dir, "sess_12345678", file());
    expect((await readdir(dir)).sort()).toEqual(["sess_12345678.transcript.json", "sess_12345678.transcript.md"]);
    expect(await readTranscriptFile(dir, "sess_12345678")).toEqual(file());
  });

  it("the markdown reads as turns with [mm:ss]", async () => {
    const md = renderMarkdown(file(), { requests: 3, totalTokens: 900 });
    expect(md).toContain("**TA** [00:00] Chào bạn");
    expect(md).toContain("**Candidate** [00:04] Dạ em chào chị");
    expect(md).toContain("Duration: 12:34");
    expect(md).toContain("2026-10-26T09:00:00+07:00");
    expect(md).toContain("3 requests");
    const local = renderMarkdown({ ...file(), session_id: null, call: { ...file().call, dial_mode: null } });
    expect(local).toMatch(/local only/i);
  });

  it("refuses an id that could leave the folder", async () => {
    await expect(writeTranscriptFiles(dir, "../evil", file())).rejects.toThrow();
  });

  it("gives null for a missing or damaged JSON", async () => {
    expect(await readTranscriptFile(dir, "nothing_here")).toBeNull();
    await writeFile(path.join(dir, "bad_12345.transcript.json"), "{not json");
    expect(await readTranscriptFile(dir, "bad_12345")).toBeNull();
    await writeFile(path.join(dir, "odd_12345.transcript.json"), JSON.stringify({ schema_version: 1, session_id: 3 }));
    expect(await readTranscriptFile(dir, "odd_12345")).toBeNull();
  });
});

describe("writeFileAtomic", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "tcr-atomic-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("replaces the file and leaves no temp file behind", async () => {
    const f = path.join(dir, "q.json");
    await writeFileAtomic(f, "one");
    await writeFileAtomic(f, "two");
    expect(await readFile(f, "utf8")).toBe("two");
    expect(await readdir(dir)).toEqual(["q.json"]);
  });
});
