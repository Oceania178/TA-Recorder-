import { describe, it, expect } from "vitest";
import { parseRetryAfter, backoffMs, fetchWithTimeout, type FetchLike } from "../../src/core/http";

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-10-29T10:00:00Z");

  it("reads seconds", () => {
    expect(parseRetryAfter("7", now)).toBe(7000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
  });

  it("reads an HTTP date", () => {
    expect(parseRetryAfter("Thu, 29 Oct 2026 10:00:30 GMT", now)).toBe(30_000);
  });

  it("gives 0 for a date in the past and null for junk or nothing", () => {
    expect(parseRetryAfter("Thu, 29 Oct 2026 09:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter("-3", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe("backoffMs", () => {
  it("doubles from the base and stops at the cap", () => {
    const noJitter = () => 0.5; // jitter factor 1.0
    expect(backoffMs(0, { baseMs: 1000, maxMs: 60_000, random: noJitter })).toBe(1000);
    expect(backoffMs(3, { baseMs: 1000, maxMs: 60_000, random: noJitter })).toBe(8000);
    expect(backoffMs(20, { baseMs: 1000, maxMs: 60_000, random: noJitter })).toBe(60_000);
  });

  it("jitters within ±20 %", () => {
    expect(backoffMs(2, { baseMs: 1000, maxMs: 60_000, random: () => 0 })).toBe(3200);
    expect(backoffMs(2, { baseMs: 1000, maxMs: 60_000, random: () => 1 })).toBe(4800);
  });
});

describe("fetchWithTimeout", () => {
  it("returns the response when it arrives in time", async () => {
    const fetch: FetchLike = async () => ({ status: 204, headers: { get: () => null }, text: async () => "" });
    const r = await fetchWithTimeout(fetch, "https://x.test/", { method: "POST", headers: {} }, 1000);
    expect(r.status).toBe(204);
  });

  it("aborts and throws a TimeoutError when the server never answers", async () => {
    const fetch: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
    await expect(fetchWithTimeout(fetch, "https://x.test/", { method: "POST", headers: {} }, 20))
      .rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("always refuses redirects (a redirect could carry the ticket elsewhere)", async () => {
    let seen: string | undefined;
    const fetch: FetchLike = async (_url, init) => {
      seen = init.redirect;
      return { status: 200, headers: { get: () => null }, text: async () => "" };
    };
    await fetchWithTimeout(fetch, "https://x.test/", { method: "GET", headers: {} }, 1000);
    expect(seen).toBe("error");
  });
});
