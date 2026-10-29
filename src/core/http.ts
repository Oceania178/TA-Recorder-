// core/http.ts — the small HTTP helpers the Solace and Gemini clients share.
// `fetch` is always injected (tests stub it; no real network in tests). Nothing here logs.

export interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface RequestInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: "error" | "follow" | "manual";
}

/** The part of the global `fetch` the core uses. Node's / Electron's `fetch` satisfies it. */
export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;

/**
 * Milliseconds to wait from a `Retry-After` header — whole seconds or an HTTP date — or null when the
 * header is missing or unreadable. A date in the past means "now" (0).
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (value == null) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  if (!/[a-z]/i.test(v)) return null; // "-3", "1.5": not seconds, not a date
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/** Exponential backoff: base × 2^attempt, capped, with ±20 % jitter so many laptops don't retry in step. */
export function backoffMs(attempt: number, o: { baseMs: number; maxMs: number; random?: () => number }): number {
  const raw = Math.min(o.maxMs, o.baseMs * 2 ** Math.max(0, attempt));
  const jitter = 0.8 + 0.4 * (o.random ?? Math.random)();
  return Math.round(Math.min(o.maxMs, raw * jitter));
}

/**
 * One request with a hard timeout. Redirects are always refused: a redirect could take the ticket, the
 * transcript or the key to another address than the pinned one (D-143).
 */
export async function fetchWithTimeout(
  fetch: FetchLike, url: string, init: RequestInitLike, timeoutMs: number,
): Promise<ResponseLike> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "error" });
  } catch (e) {
    if (timedOut) {
      const err = new Error("The request timed out");
      err.name = "TimeoutError";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** The response body as JSON, or null when it is empty or not JSON. Never throws. */
export async function readJson(res: ResponseLike): Promise<unknown> {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
