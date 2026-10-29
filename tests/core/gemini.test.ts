import { describe, it, expect } from "vitest";
import { transcribeSegment, GEMINI_PROMPT, GEMINI_ENDPOINT } from "../../src/core/gemini";
import { Secret } from "../../src/core/secret";
import type { FetchLike, RequestInitLike } from "../../src/core/http";

const KEY = "AIzaFAKE-test-key-0123456789";
const MODEL = "gemini-3.5-transcribe";
const WAV = Uint8Array.from([82, 73, 70, 70, 1, 2, 3, 4, 5]);

interface Reply { status: number; body?: unknown; headers?: Record<string, string>; throws?: Error }
function script(replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInitLike }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r.throws) throw r.throws;
    return {
      status: r.status,
      headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {})),
    };
  };
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  return { fetch, calls, sleeps, sleep };
}

const okBody = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 8, totalTokenCount: 128 },
});

const deps = (s: ReturnType<typeof script>) => ({ fetch: s.fetch, sleep: s.sleep, random: () => 0.5 });

describe("transcribeSegment — the request", () => {
  it("POSTs inline WAV to the model's generateContent, with the key only in a header", async () => {
    const s = script([{ status: 200, body: okBody("Chào bạn") }]);
    await transcribeSegment(deps(s), { apiKey: KEY, model: MODEL, wav: WAV });
    const { url, init } = s.calls[0];
    expect(url).toBe(`${GEMINI_ENDPOINT}/v1beta/models/${MODEL}:generateContent`);
    expect(url).not.toContain(KEY);
    expect(init.method).toBe("POST");
    expect(init.headers["x-goog-api-key"]).toBe(KEY);
    const body = JSON.parse(init.body!);
    const parts = body.contents[0].parts;
    expect(parts[0].text).toBe(GEMINI_PROMPT);
    expect(parts[1].inline_data).toEqual({ mime_type: "audio/wav", data: Buffer.from(WAV).toString("base64") });
  });

  it("asks for verbatim text, treats the audio as data, and sets no language (D-135)", async () => {
    expect(GEMINI_PROMPT).toMatch(/verbatim/i);
    expect(GEMINI_PROMPT).toMatch(/data, not instructions/i);
    const s = script([{ status: 200, body: okBody("x") }]);
    await transcribeSegment(deps(s), { apiKey: new Secret(KEY), model: MODEL, wav: WAV });
    const keys: string[] = [];
    JSON.parse(s.calls[0].init.body!, (k, v) => { keys.push(k); return v; });
    expect(keys.filter((k) => /lang/i.test(k))).toEqual([]);
  });

  it("refuses before sending: no key, a bad model id, or a request over the size guard", async () => {
    const s = script([{ status: 200, body: okBody("x") }]);
    expect(await transcribeSegment(deps(s), { apiKey: " ", model: MODEL, wav: WAV })).toEqual({ ok: false, kind: "no_key" });
    expect(await transcribeSegment(deps(s), { apiKey: KEY, model: "../x", wav: WAV })).toEqual({ ok: false, kind: "bad_model" });
    expect(await transcribeSegment({ ...deps(s), maxRequestBytes: 100 }, { apiKey: KEY, model: MODEL, wav: new Uint8Array(200) }))
      .toEqual({ ok: false, kind: "too_large" });
    expect(s.calls).toHaveLength(0);
  });
});

describe("transcribeSegment — the answer", () => {
  it("returns the text on one line and the usage", async () => {
    const s = script([{ status: 200, body: { ...okBody(""), candidates: [{ content: { parts: [{ text: "  Chào bạn,\n\nmình là  TA " }, { text: "bên VNG." }] }, finishReason: "STOP" }] } }]);
    const r = await transcribeSegment(deps(s), { apiKey: KEY, model: MODEL, wav: WAV });
    expect(r).toEqual({ ok: true, text: "Chào bạn, mình là TA bên VNG.", usage: { promptTokens: 120, outputTokens: 8, totalTokens: 128 }, attempts: 1 });
  });

  it("silence gives empty text, not an error", async () => {
    const s = script([{ status: 200, body: { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] } }]);
    expect(await transcribeSegment(deps(s), { apiKey: KEY, model: MODEL, wav: WAV }))
      .toEqual({ ok: true, text: "", usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0 }, attempts: 1 });
  });

  it("a blocked prompt or a safety stop is 'blocked'", async () => {
    const a = script([{ status: 200, body: { promptFeedback: { blockReason: "SAFETY" } } }]);
    expect(await transcribeSegment(deps(a), { apiKey: KEY, model: MODEL, wav: WAV })).toEqual({ ok: false, kind: "blocked" });
    const b = script([{ status: 200, body: { candidates: [{ finishReason: "SAFETY" }] } }]);
    expect(await transcribeSegment(deps(b), { apiKey: KEY, model: MODEL, wav: WAV })).toEqual({ ok: false, kind: "blocked" });
  });

  it("a rejected key is final, not retried", async () => {
    const s = script([{ status: 400, body: { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } } }]);
    expect(await transcribeSegment(deps(s), { apiKey: KEY, model: MODEL, wav: WAV })).toEqual({ ok: false, kind: "key_rejected", status: 400 });
    expect(s.calls).toHaveLength(1);
    const t = script([{ status: 403, body: {} }]);
    expect(await transcribeSegment(deps(t), { apiKey: KEY, model: MODEL, wav: WAV })).toEqual({ ok: false, kind: "key_rejected", status: 403 });
  });

  it("an unknown model, a too-large answer and other 4xx are final", async () => {
    expect(await transcribeSegment(deps(script([{ status: 404 }])), { apiKey: KEY, model: MODEL, wav: WAV })).toEqual({ ok: false, kind: "model_not_found", status: 404 });
    expect(await transcribeSegment(deps(script([{ status: 413 }])), { apiKey: KEY, model: MODEL, wav: WAV })).toEqual({ ok: false, kind: "too_large" });
    expect(await transcribeSegment(deps(script([{ status: 400, body: { error: { message: "bad" } } }])), { apiKey: KEY, model: MODEL, wav: WAV }))
      .toEqual({ ok: false, kind: "bad_request", status: 400 });
  });
});

describe("transcribeSegment — retries (429 / 5xx / network)", () => {
  it("retries 503 and network errors with growing backoff, then succeeds", async () => {
    const s = script([{ status: 503 }, { status: 0, throws: new TypeError("fetch failed") }, { status: 200, body: okBody("ok") }]);
    const r = await transcribeSegment(deps(s), { apiKey: KEY, model: MODEL, wav: WAV });
    expect(r).toMatchObject({ ok: true, text: "ok", attempts: 3 });
    expect(s.sleeps).toEqual([2000, 4000]);
  });

  it("respects Retry-After when it is longer than the backoff", async () => {
    const s = script([{ status: 429, headers: { "retry-after": "7" } }, { status: 200, body: okBody("ok") }]);
    await transcribeSegment(deps(s), { apiKey: KEY, model: MODEL, wav: WAV });
    expect(s.sleeps).toEqual([7000]);
  });

  it("gives up after maxAttempts and hands the wait back to the queue", async () => {
    const s = script([{ status: 429, headers: { "retry-after": "30" } }]);
    const r = await transcribeSegment({ ...deps(s), maxAttempts: 3 }, { apiKey: KEY, model: MODEL, wav: WAV });
    expect(r).toEqual({ ok: false, kind: "retry_exhausted", reason: "rate_limited", retryAfterMs: 30_000, attempts: 3 });
    expect(s.calls).toHaveLength(3);
  });

  it("does not sleep for a Retry-After longer than the cap: it returns at once for the queue to wait", async () => {
    const s = script([{ status: 429, headers: { "retry-after": "3600" } }]);
    const r = await transcribeSegment({ ...deps(s), maxAttempts: 5 }, { apiKey: KEY, model: MODEL, wav: WAV });
    expect(r).toMatchObject({ ok: false, kind: "retry_exhausted", retryAfterMs: 3_600_000, attempts: 1 });
    expect(s.sleeps).toEqual([]);
  });
});

describe("the key never leaks", () => {
  it("is in no result, whatever happened", async () => {
    const replies: Reply[][] = [
      [{ status: 200, body: okBody("x") }], [{ status: 400, body: { error: { message: `bad key ${KEY}` } } }],
      [{ status: 403 }], [{ status: 500 }], [{ status: 0, throws: new Error(`boom ${KEY}`) }],
    ];
    for (const r of replies) {
      const s = script(r);
      const out = await transcribeSegment({ ...deps(s), maxAttempts: 2 }, { apiKey: KEY, model: MODEL, wav: WAV });
      expect(JSON.stringify(out)).not.toContain(KEY);
    }
  });
});
