// core/solaceClient.ts — the app's two calls to Solace (Solace docs/specs/call-recorder.md "The ticket
// check", "The data contract", "What the app must do on each answer"; spec v1.22 §8.24; D-85, D-139,
// D-143, D-144, D-147).
//
// - Only to the pinned Solace origin (validated again here, so a bad setting can never send anywhere).
// - The ticket travels only in `Authorization: Bearer`; results never carry tickets or transcript text,
//   and nothing here logs.
// - The upload body is built field by field from the contract (schema_version 1), so whatever else the
//   object holds — a path, audio, a key — is never sent (D-139). The same payload always gives the same
//   bytes, so a resend is the same request and Solace answers it with the same call_id (D-85).
// - Every answer maps to one kind the queue acts on; 429, 5xx, network errors and timeouts are retryable.
import { fetchWithTimeout, parseRetryAfter, readJson, isObject, type FetchLike, type ResponseLike } from "./http";
import { Secret, revealSecret } from "./secret";
import { validateSolaceBaseUrl } from "./settings";
import { isDialMode, type DialMode, type TranscriptPayload } from "./types";

export const TICKET_CHECK_PATH = "/api/call-recorder/tickets/check";
export const TRANSCRIPTS_PATH = "/api/call-recorder/transcripts";
/** Solace's own limit on the transcript body (contract.ts TRANSCRIPT_BODY_LIMIT, "2mb" = 2 MiB). */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
/** Solace asks for "a minute or more" after a 429. */
export const RATE_LIMIT_BACKOFF_MS = 60_000;
const DEFAULT_CHECK_TIMEOUT_MS = 15_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;
/** Cap the reasons shown to the TA (they are field paths and rules, never transcript text). */
const MAX_REASONS = 20;

export interface SolaceDeps {
  fetch: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  /** Development only: allow http://localhost as the pinned address. */
  dev?: boolean;
}

export type Retryable = {
  ok: false;
  kind: "retryable";
  reason: "rate_limited" | "server_error" | "network" | "timeout";
  /** How long to wait at least, when the server said so (always ≥ 60 s for a 429). */
  retryAfterMs: number | null;
};

export type CheckResult =
  | { ok: true; sessionId: string; dialMode: DialMode; uploadTicket: Secret; sendBy: string; serverTime: string | null }
  /** The ticket was already checked: Solace never hands out a second upload ticket (D-147). */
  | { ok: false; kind: "already_checked"; sendBy: string }
  /** The uniform 401 (or an answer for another session): record nothing, ask the TA to press again. */
  | { ok: false; kind: "refused" }
  | { ok: false; kind: "bad_address" }
  | Retryable
  | { ok: false; kind: "unexpected"; status: number };

export type UploadResult =
  | { ok: true; callId: string; duplicate: boolean }
  /** 409: Solace already has a different call for this session — tell the TA; never resend. */
  | { ok: false; kind: "different_content" }
  /** 401: wrong, expired or used ticket — stop retrying, the TA writes notes by hand. */
  | { ok: false; kind: "refused" }
  /** 400: final for this body — keep the file, do not resend, show the reasons. */
  | { ok: false; kind: "invalid"; reasons: string[]; serverTime: string | null }
  | { ok: false; kind: "too_large" }
  /** 415: a bug in the app. */
  | { ok: false; kind: "not_json" }
  | { ok: false; kind: "bad_address" }
  | Retryable
  | { ok: false; kind: "unexpected"; status: number };

function errorKind(e: unknown): Retryable {
  const timeout = e instanceof Error && e.name === "TimeoutError";
  return { ok: false, kind: "retryable", reason: timeout ? "timeout" : "network", retryAfterMs: null };
}

/** 429 and 5xx answers, or null for anything else. */
function retryableStatus(res: ResponseLike, now: number): Retryable | null {
  const after = parseRetryAfter(res.headers.get("retry-after"), now);
  if (res.status === 429) {
    return { ok: false, kind: "retryable", reason: "rate_limited", retryAfterMs: Math.max(RATE_LIMIT_BACKOFF_MS, after ?? 0) };
  }
  if (res.status >= 500 && res.status <= 599) return { ok: false, kind: "retryable", reason: "server_error", retryAfterMs: after };
  return null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Step ①b: check the LINK ticket at the pinned address before recording anything (D-143, D-147). */
export async function checkTicket(
  deps: SolaceDeps, baseUrl: string, sessionId: string, linkTicket: string | Secret,
): Promise<CheckResult> {
  const base = validateSolaceBaseUrl(baseUrl, { dev: deps.dev });
  if (!base.ok) return { ok: false, kind: "bad_address" };
  const now = deps.now ?? Date.now;

  let res: ResponseLike;
  try {
    res = await fetchWithTimeout(deps.fetch, `${base.url}${TICKET_CHECK_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${revealSecret(linkTicket)}`, Accept: "application/json" },
    }, deps.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS);
  } catch (e) {
    return errorKind(e);
  }

  if (res.status === 401) return { ok: false, kind: "refused" };
  const retry = retryableStatus(res, now());
  if (retry) return retry;
  if (res.status !== 200) return { ok: false, kind: "unexpected", status: res.status };

  const body = await readJson(res);
  if (!isObject(body) || body.ok !== true || !str(body.session_id) || !isDialMode(body.dial_mode) || !str(body.upload_until)) {
    return { ok: false, kind: "unexpected", status: 200 };
  }
  // The answer must be for the session the link named; anything else is treated as a refusal.
  if (body.session_id !== sessionId) return { ok: false, kind: "refused" };
  const sendBy = body.upload_until as string;
  const uploadTicket = str(body.upload_ticket);
  if (!uploadTicket) return { ok: false, kind: "already_checked", sendBy };
  return { ok: true, sessionId, dialMode: body.dial_mode, uploadTicket: new Secret(uploadTicket), sendBy, serverTime: str(body.server_time) };
}

/** The §8.24 ② body: the contract's fields only, in a fixed order, so equal payloads give equal bytes. */
export function serialisePayload(p: TranscriptPayload): string {
  const clean: TranscriptPayload = {
    schema_version: 1,
    session_id: p.session_id,
    call: {
      started_at: p.call.started_at,
      ended_at: p.call.ended_at,
      duration_s: p.call.duration_s,
      dial_mode: p.call.dial_mode,
      has_content: p.call.has_content,
    },
    transcript: {
      segments: p.transcript.segments.map((s) => ({ speaker: s.speaker, start_ms: s.start_ms, end_ms: s.end_ms, text: s.text })),
      model: p.transcript.model,
    },
    recorder: { app_version: p.recorder.app_version },
  };
  return JSON.stringify(clean);
}

/** Step ②: send one call's transcript with the UPLOAD ticket. A resend is the same call (D-85). */
export async function uploadTranscript(
  deps: SolaceDeps, baseUrl: string, uploadTicket: string | Secret, payload: TranscriptPayload,
): Promise<UploadResult> {
  const base = validateSolaceBaseUrl(baseUrl, { dev: deps.dev });
  if (!base.ok) return { ok: false, kind: "bad_address" };
  const body = serialisePayload(payload);
  if (Buffer.byteLength(body, "utf8") > MAX_UPLOAD_BYTES) return { ok: false, kind: "too_large" };
  const now = deps.now ?? Date.now;

  let res: ResponseLike;
  try {
    res = await fetchWithTimeout(deps.fetch, `${base.url}${TRANSCRIPTS_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${revealSecret(uploadTicket)}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
    }, deps.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS);
  } catch (e) {
    return errorKind(e);
  }

  switch (res.status) {
    case 200:
    case 201: {
      const json = await readJson(res);
      const callId = isObject(json) ? str(json.call_id) : null;
      if (!callId) return { ok: false, kind: "unexpected", status: res.status };
      return { ok: true, callId, duplicate: res.status === 200 };
    }
    case 401: return { ok: false, kind: "refused" };
    case 409: return { ok: false, kind: "different_content" };
    case 413: return { ok: false, kind: "too_large" };
    case 415: return { ok: false, kind: "not_json" };
    case 400: {
      const json = await readJson(res);
      const reasons = isObject(json) && Array.isArray(json.reasons)
        ? json.reasons.filter((r): r is string => typeof r === "string").slice(0, MAX_REASONS)
        : [];
      const error = isObject(json) ? str(json.error) : null;
      return {
        ok: false,
        kind: "invalid",
        reasons: reasons.length ? reasons : [error ?? "invalid_request"],
        serverTime: isObject(json) ? str(json.server_time) : null,
      };
    }
    default: {
      const retry = retryableStatus(res, now());
      return retry ?? { ok: false, kind: "unexpected", status: res.status };
    }
  }
}
