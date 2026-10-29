import { describe, it, expect } from "vitest";
import { inspect } from "node:util";
import { checkTicket, uploadTranscript, serialisePayload, TICKET_CHECK_PATH, TRANSCRIPTS_PATH } from "../../src/core/solaceClient";
import { Secret } from "../../src/core/secret";
import type { FetchLike, RequestInitLike } from "../../src/core/http";
import type { TranscriptPayload } from "../../src/core/types";

const BASE = "https://solace.test";
const SID = "cmh2x9k0a0001qz8v7y6t5r4e";
const LINK_TICKET = "L".repeat(43);
const UPLOAD_TICKET = "U".repeat(43);

interface Call { url: string; init: RequestInitLike }
function stub(status: number, body: unknown, headers: Record<string, string> = {}): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  return { fetch, calls };
}
const failing = (err: Error): FetchLike => async () => { throw err; };

const payload: TranscriptPayload = {
  schema_version: 1,
  session_id: SID,
  call: { started_at: "2026-10-26T09:00:00+07:00", ended_at: "2026-10-26T09:12:34+07:00", duration_s: 754, dial_mode: "3cx", has_content: true },
  transcript: { segments: [{ speaker: "ta", start_ms: 0, end_ms: 4000, text: "Chào bạn" }], model: "gemini-3.5-transcribe" },
  recorder: { app_version: "0.1.0" },
};

describe("checkTicket (step ①b)", () => {
  const okBody = { ok: true, session_id: SID, dial_mode: "3cx", upload_until: "2026-10-29T10:00:00.000Z", upload_ticket: UPLOAD_TICKET, server_time: "2026-10-26T10:00:00.000Z" };

  it("POSTs the link ticket as a Bearer to the pinned address, with no body", async () => {
    const s = stub(200, okBody);
    await checkTicket({ fetch: s.fetch }, BASE, SID, LINK_TICKET);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].url).toBe(`${BASE}${TICKET_CHECK_PATH}`);
    expect(TICKET_CHECK_PATH).toBe("/api/call-recorder/tickets/check");
    expect(s.calls[0].init.method).toBe("POST");
    expect(s.calls[0].init.headers.Authorization).toBe(`Bearer ${LINK_TICKET}`);
    expect(s.calls[0].init.body).toBeUndefined();
  });

  it("returns the upload ticket (hidden from logs), the send-by time and the server time", async () => {
    const r = await checkTicket({ fetch: stub(200, okBody).fetch }, BASE, SID, new Secret(LINK_TICKET));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.uploadTicket.reveal()).toBe(UPLOAD_TICKET);
    expect(r.sendBy).toBe("2026-10-29T10:00:00.000Z");
    expect(r.serverTime).toBe("2026-10-26T10:00:00.000Z");
    expect(r.dialMode).toBe("3cx");
    expect(JSON.stringify(r)).not.toContain(UPLOAD_TICKET);
    expect(inspect(r, { depth: 5 })).not.toContain(UPLOAD_TICKET);
  });

  it("a repeated check (no upload ticket) says so: the app can only use one it already holds", async () => {
    const { upload_ticket: _drop, ...again } = okBody;
    const r = await checkTicket({ fetch: stub(200, again).fetch }, BASE, SID, LINK_TICKET);
    expect(r).toEqual({ ok: false, kind: "already_checked", sendBy: okBody.upload_until });
  });

  it("refuses an answer for another session", async () => {
    const r = await checkTicket({ fetch: stub(200, { ...okBody, session_id: "someoneelse123" }).fetch }, BASE, SID, LINK_TICKET);
    expect(r).toEqual({ ok: false, kind: "refused" });
  });

  it("401 is the uniform refusal: record nothing", async () => {
    const r = await checkTicket({ fetch: stub(401, { error: "invalid_or_expired_ticket" }).fetch }, BASE, SID, LINK_TICKET);
    expect(r).toEqual({ ok: false, kind: "refused" });
  });

  it("429 backs off at least a minute, honouring a longer Retry-After", async () => {
    expect(await checkTicket({ fetch: stub(429, {}).fetch }, BASE, SID, LINK_TICKET))
      .toEqual({ ok: false, kind: "retryable", reason: "rate_limited", retryAfterMs: 60_000 });
    expect(await checkTicket({ fetch: stub(429, {}, { "retry-after": "120" }).fetch }, BASE, SID, LINK_TICKET))
      .toEqual({ ok: false, kind: "retryable", reason: "rate_limited", retryAfterMs: 120_000 });
  });

  it("5xx, network errors and timeouts are retryable", async () => {
    expect(await checkTicket({ fetch: stub(503, "down").fetch }, BASE, SID, LINK_TICKET))
      .toMatchObject({ ok: false, kind: "retryable", reason: "server_error" });
    expect(await checkTicket({ fetch: failing(new TypeError("fetch failed")) }, BASE, SID, LINK_TICKET))
      .toMatchObject({ ok: false, kind: "retryable", reason: "network" });
    const hang: FetchLike = (_u, init) => new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("abort"))));
    expect(await checkTicket({ fetch: hang, timeoutMs: 20 }, BASE, SID, LINK_TICKET))
      .toMatchObject({ ok: false, kind: "retryable", reason: "timeout" });
  });

  it("never calls an address that is not a valid pinned origin", async () => {
    const s = stub(200, okBody);
    expect(await checkTicket({ fetch: s.fetch }, "http://solace.test", SID, LINK_TICKET)).toEqual({ ok: false, kind: "bad_address" });
    expect(await checkTicket({ fetch: s.fetch }, "https://solace.test/evil", SID, LINK_TICKET)).toEqual({ ok: false, kind: "bad_address" });
    expect(s.calls).toHaveLength(0);
  });

  it("a malformed 200 is unexpected, not ok", async () => {
    expect(await checkTicket({ fetch: stub(200, "<html>").fetch }, BASE, SID, LINK_TICKET)).toEqual({ ok: false, kind: "unexpected", status: 200 });
  });
});

describe("uploadTranscript (step ②③)", () => {
  it("POSTs exactly the §8.24 JSON with the upload ticket as a Bearer", async () => {
    const s = stub(201, { call_id: "call_1" });
    const r = await uploadTranscript({ fetch: s.fetch }, BASE, UPLOAD_TICKET, payload);
    expect(r).toEqual({ ok: true, callId: "call_1", duplicate: false });
    const c = s.calls[0];
    expect(c.url).toBe(`${BASE}${TRANSCRIPTS_PATH}`);
    expect(TRANSCRIPTS_PATH).toBe("/api/call-recorder/transcripts");
    expect(c.init.method).toBe("POST");
    expect(c.init.headers.Authorization).toBe(`Bearer ${UPLOAD_TICKET}`);
    expect(c.init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(c.init.body!)).toEqual(payload);
  });

  it("sends only the contract's fields, whatever else the object carries (D-139: no audio, no file)", async () => {
    const s = stub(201, { call_id: "c" });
    const dirty = {
      ...payload, audio: "AAAA", api_key: "k",
      call: { ...payload.call, file: "C:\\a.webm" },
      transcript: { ...payload.transcript, language: "vi", segments: [{ ...payload.transcript.segments[0], wav: "x" }] },
      recorder: { ...payload.recorder, path: "x" },
    } as unknown as TranscriptPayload;
    await uploadTranscript({ fetch: s.fetch }, BASE, new Secret(UPLOAD_TICKET), dirty);
    expect(JSON.parse(s.calls[0].init.body!)).toEqual(payload);
  });

  it("a resend of the same payload is byte-for-byte the same request (D-85)", async () => {
    const s = stub(200, { call_id: "call_1", duplicate: true });
    const r1 = await uploadTranscript({ fetch: s.fetch }, BASE, UPLOAD_TICKET, payload);
    const r2 = await uploadTranscript({ fetch: s.fetch }, BASE, UPLOAD_TICKET, JSON.parse(JSON.stringify(payload)));
    expect(s.calls[0].init.body).toBe(s.calls[1].init.body);
    expect(r1).toEqual({ ok: true, callId: "call_1", duplicate: true });
    expect(r2).toEqual(r1);
    expect(serialisePayload(payload)).toBe(s.calls[0].init.body);
  });

  const answers: Array<[string, number, unknown, Record<string, string>, unknown]> = [
    ["409 different content", 409, { error: "different_content_for_session" }, {}, { ok: false, kind: "different_content" }],
    ["401 refused", 401, { error: "invalid_or_expired_ticket" }, {}, { ok: false, kind: "refused" }],
    ["400 invalid with reasons", 400, { error: "invalid_transcript", reasons: ["call.dial_mode must be one of 3cx, self_dial"], server_time: "2026-10-26T10:00:00.000Z" }, {},
      { ok: false, kind: "invalid", reasons: ["call.dial_mode must be one of 3cx, self_dial"], serverTime: "2026-10-26T10:00:00.000Z" }],
    ["400 invalid json", 400, { error: "invalid_json" }, {}, { ok: false, kind: "invalid", reasons: ["invalid_json"], serverTime: null }],
    ["413 too large", 413, { error: "payload_too_large" }, {}, { ok: false, kind: "too_large" }],
    ["415 json only (a bug in the app)", 415, { error: "json_only" }, {}, { ok: false, kind: "not_json" }],
    ["429 rate limited", 429, { error: "too_many_requests" }, { "retry-after": "5" }, { ok: false, kind: "retryable", reason: "rate_limited", retryAfterMs: 60_000 }],
    ["500 server error", 500, "boom", {}, { ok: false, kind: "retryable", reason: "server_error", retryAfterMs: null }],
    ["502 bad gateway", 502, "", {}, { ok: false, kind: "retryable", reason: "server_error", retryAfterMs: null }],
    ["404 unexpected", 404, "", {}, { ok: false, kind: "unexpected", status: 404 }],
  ];
  for (const [name, status, body, headers, expected] of answers) {
    it(name, async () => {
      expect(await uploadTranscript({ fetch: stub(status, body, headers).fetch }, BASE, UPLOAD_TICKET, payload)).toEqual(expected);
    });
  }

  it("network errors are retryable", async () => {
    expect(await uploadTranscript({ fetch: failing(new TypeError("fetch failed")) }, BASE, UPLOAD_TICKET, payload))
      .toEqual({ ok: false, kind: "retryable", reason: "network", retryAfterMs: null });
  });

  it("over 2 MB is refused locally, never sent", async () => {
    const s = stub(201, { call_id: "c" });
    const huge = { ...payload, transcript: { ...payload.transcript, segments: [{ speaker: "ta" as const, start_ms: 0, end_ms: 1, text: "xin chào ".repeat(300_000) }] } };
    expect(await uploadTranscript({ fetch: s.fetch }, BASE, UPLOAD_TICKET, huge)).toEqual({ ok: false, kind: "too_large" });
    expect(s.calls).toHaveLength(0);
  });

  it("never sends to an address that is not a valid pinned origin", async () => {
    const s = stub(201, { call_id: "c" });
    expect(await uploadTranscript({ fetch: s.fetch }, BASE + "/x", UPLOAD_TICKET, payload)).toEqual({ ok: false, kind: "bad_address" });
    expect(s.calls).toHaveLength(0);
  });

  it("no result ever carries the ticket or the transcript text", async () => {
    for (const [, status, body, headers] of answers) {
      const r = await uploadTranscript({ fetch: stub(status, body, headers).fetch }, BASE, UPLOAD_TICKET, payload);
      const s = JSON.stringify(r);
      expect(s).not.toContain(UPLOAD_TICKET);
      expect(s).not.toContain("Chào bạn");
    }
  });
});

describe("Secret", () => {
  it("hides its value from String, JSON and inspect", () => {
    const s = new Secret("top-secret-value");
    expect(String(s)).toBe("[hidden]");
    expect(JSON.stringify({ s })).toBe('{"s":"[hidden]"}');
    expect(inspect(s)).toBe("[hidden]");
    expect(s.reveal()).toBe("top-secret-value");
  });
});
