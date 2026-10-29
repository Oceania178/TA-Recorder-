// The "Recent calls" list and the first-run wizard's checks (no Electron, no network: fetch is a stub).
import { describe, expect, it } from "vitest";
import { callRows, reasonText } from "../../src/main/callsView";
import { telLink, testSolaceAddress, WINDOWS_MIC_SETTINGS } from "../../src/main/wizardChecks";
import type { FailureReason, FetchLike, Job, RequestInitLike } from "../../src/core";

const SID = "cmh2x9k0a0001qz8v7y6t5r4e";
const job = (over: Partial<Job>): Job => ({
  id: SID, sessionId: SID, dialMode: "3cx", folder: "C:\\x", startedAt: "2026-10-29T10:00:00+07:00", endedAt: "2026-10-29T10:12:30+07:00",
  sendBy: null, stage: "recorded", attempts: 0, nextAttemptAt: null, callId: null, duplicate: false, failure: null,
  createdAt: "2026-10-29T03:12:31.000Z", updatedAt: "2026-10-29T03:12:31.000Z", ...over,
});

describe("Recent calls", () => {
  it("shows date, length, linked or local, and the stage in plain words; newest first", () => {
    const rows = callRows([
      job({ id: "20261028-090000-aaaaaa", sessionId: null, dialMode: null, startedAt: "2026-10-28T09:00:00+07:00", endedAt: "2026-10-28T09:00:45+07:00", stage: "local_only" }),
      job({ stage: "sent", callId: "call_1" }),
    ], { hasKey: true, transcriptIds: new Set([SID]) });
    expect(rows.map((r) => r.id)).toEqual([SID, "20261028-090000-aaaaaa"]);
    expect(rows[0]).toMatchObject({ startedAt: "2026-10-29T10:00:00+07:00", durationS: 750, linked: true, stage: "Sent", canRetry: false, hasTranscript: true });
    expect(rows[1]).toMatchObject({ linked: false, stage: "Transcribed", detail: "Local only — not linked to Solace", hasTranscript: false });
  });

  it("names every stage", () => {
    const stages: [Job["stage"], string][] = [
      ["recorded", "Recorded"], ["transcribing", "Transcribing"], ["transcribed", "Transcribed"], ["sending", "Sending"], ["sent", "Sent"],
    ];
    for (const [stage, label] of stages) expect(callRows([job({ stage })], { hasKey: true, transcriptIds: new Set() })[0].stage).toBe(label);
  });

  it("says to add a Gemini key when a recorded call waits for one", () => {
    const [row] = callRows([job({ stage: "recorded" })], { hasKey: false, transcriptIds: new Set() });
    expect(row.detail).toBe("Add a Gemini key in Settings to transcribe");
  });

  it("shows a failure with its reason and a Retry button", () => {
    const [row] = callRows([job({ stage: "failed", failure: { reason: "solace_refused", at: "2026-10-29T04:00:00Z", stage: "transcribed" } })], { hasKey: true, transcriptIds: new Set() });
    expect(row).toMatchObject({ stage: "Failed", canRetry: true });
    expect(row.detail).toMatch(/Solace did not accept/);
  });

  it("has plain words for every failure reason", () => {
    const reasons: FailureReason[] = [
      "no_gemini_key", "gemini_key_rejected", "gemini_model_not_found", "gemini_bad_request", "audio_missing", "no_solace_address",
      "upload_ticket_missing", "upload_window_closed", "transcript_missing", "solace_refused", "solace_invalid",
      "solace_different_content", "transcript_too_large", "app_bug", "unexpected_error",
    ];
    for (const r of reasons) expect(reasonText(r), r).toMatch(/^[A-Z].{10,}/);
  });

  it("never carries the folder path to the window", () => {
    const [row] = callRows([job({ folder: "C:\\Users\\ta\\Documents\\Sound Recordings\\TA Call Recorder\\x" })], { hasKey: true, transcriptIds: new Set() });
    expect(JSON.stringify(row)).not.toContain("Sound Recordings");
  });
});

describe("wizard step 4: testing the Solace address", () => {
  function fetchAnswering(answer: { status: number; body?: unknown } | Error) {
    const seen: { url: string; init: RequestInitLike }[] = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, init });
      if (answer instanceof Error) throw answer;
      return { status: answer.status, headers: { get: () => null }, text: async () => (answer.body === undefined ? "" : JSON.stringify(answer.body)) };
    };
    return { fetch, seen };
  }

  it("uses Solace's public, content-free health route, with no ticket and no redirects", async () => {
    const f = fetchAnswering({ status: 200, body: { ok: true, service: "vngg-ats", modules: [] } });
    const r = await testSolaceAddress(f.fetch, "https://solace.vng.vn/");
    expect(r).toMatchObject({ ok: true, level: "solace", url: "https://solace.vng.vn" });
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0].url).toBe("https://solace.vng.vn/api/health");
    expect(f.seen[0].init.method).toBe("GET");
    expect(f.seen[0].init.redirect).toBe("error");
    expect(JSON.stringify(f.seen[0].init.headers)).not.toMatch(/authorization/i);
  });

  it("says the address answers over https but the real test is Solace's button, when it is not Solace's health answer", async () => {
    const r = await testSolaceAddress(fetchAnswering({ status: 404 }).fetch, "https://example.vng.vn");
    expect(r).toMatchObject({ ok: true, level: "https_only" });
    expect(r.message).toMatch(/Call & record/);
  });

  it("refuses http and paths without calling anything", async () => {
    const f = fetchAnswering({ status: 200 });
    expect(await testSolaceAddress(f.fetch, "http://solace.vng.vn")).toMatchObject({ ok: false, level: "invalid" });
    expect(await testSolaceAddress(f.fetch, "https://solace.vng.vn/api")).toMatchObject({ ok: false, level: "invalid" });
    expect(f.seen).toHaveLength(0);
  });

  it("says when the address does not answer", async () => {
    const r = await testSolaceAddress(fetchAnswering(new Error("ENOTFOUND")).fetch, "https://nowhere.vng.vn");
    expect(r).toMatchObject({ ok: false, level: "unreachable" });
  });
});

describe("wizard steps 2 and 5", () => {
  it("opens the Windows microphone privacy page by its fixed address", () => {
    expect(WINDOWS_MIC_SETTINGS).toBe("ms-settings:privacy-microphone");
  });

  it("builds a tel: link only from a plain phone number the TA typed", () => {
    expect(telLink(" +84 28 1234 5678 ")).toBe("tel:+842812345678");
    expect(telLink("0901234567")).toBe("tel:0901234567");
    expect(telLink("12")).toBeNull();
    expect(telLink("javascript:alert(1)")).toBeNull();
    expect(telLink("090;123")).toBeNull();
  });
});
