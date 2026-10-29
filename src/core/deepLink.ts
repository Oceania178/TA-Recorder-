// core/deepLink.ts — parse and strictly validate Solace's deep link (Solace docs/specs/call-recorder.md
// "The deep link"; spec v1.22 §8.24 ①; D-143, D-147):
//
//   tacallrecorder://start?session_id=<id>&ticket=<link ticket>&dial_mode=<3cx|self_dial>
//
// - Exactly these three parameters, each once. Anything else (a path, a port, a fragment, an extra
//   parameter such as a server address) is refused: the link must never be able to steer where the app
//   sends (D-143 — the address is pinned in settings).
// - The LINK ticket only checks (step ①b); the app never logs it. The parsed result keeps it in a private
//   field and its toString / toJSON / util.inspect show the session id only. Read it with revealTicket(),
//   right where it goes into the Authorization header.
// - A refusal is a reason code only; it never repeats the input.
import { isDialMode, type DialMode } from "./types";

export const DEEP_LINK_SCHEME = "tacallrecorder";

/** A whole link longer than this is not one Solace made (its ticket is 43 characters). */
const MAX_LINK_LENGTH = 1024;
/** Solace's session ids are cuids (25 characters); allow some room, never path characters. */
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** Solace's tickets are 32 random bytes in base64url (43 characters). */
const TICKET = /^[A-Za-z0-9_-]{32,128}$/;
const PARAMS = ["session_id", "ticket", "dial_mode"] as const;

export type DeepLinkRefusal =
  | "not_a_string" | "too_long" | "not_a_url" | "wrong_scheme" | "wrong_action" | "unexpected_part"
  | "unknown_parameter" | "duplicate_parameter"
  | "missing_session_id" | "invalid_session_id"
  | "missing_ticket" | "invalid_ticket"
  | "missing_dial_mode" | "invalid_dial_mode";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** A valid start link. Safe to log: only the session id and dial mode ever show. */
export class StartLink {
  readonly sessionId: string;
  readonly dialMode: DialMode;
  readonly #ticket: string;

  constructor(sessionId: string, ticket: string, dialMode: DialMode) {
    this.sessionId = sessionId;
    this.dialMode = dialMode;
    this.#ticket = ticket;
  }

  /** The link ticket, for the ticket check's Authorization header only. Never log what this returns. */
  revealTicket(): string {
    return this.#ticket;
  }

  toString(): string {
    return `StartLink(session ${this.sessionId}, ${this.dialMode}, ticket hidden)`;
  }

  toJSON(): { sessionId: string; dialMode: DialMode; ticket: "[hidden]" } {
    return { sessionId: this.sessionId, dialMode: this.dialMode, ticket: "[hidden]" };
  }

  [INSPECT](): string {
    return this.toString();
  }
}

export type DeepLinkResult = { ok: true; link: StartLink } | { ok: false; reason: DeepLinkRefusal };

const refuse = (reason: DeepLinkRefusal): DeepLinkResult => ({ ok: false, reason });

export function parseDeepLink(raw: unknown): DeepLinkResult {
  if (typeof raw !== "string") return refuse("not_a_string");
  const text = raw.trim();
  if (text.length > MAX_LINK_LENGTH) return refuse("too_long");

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return refuse("not_a_url");
  }
  if (url.protocol.toLowerCase() !== `${DEEP_LINK_SCHEME}:`) return refuse("wrong_scheme");
  if (url.username || url.password || url.port || url.hash || text.includes("#")) return refuse("unexpected_part");
  if (url.hostname.toLowerCase() !== "start") return refuse("wrong_action");
  if (url.pathname !== "" && url.pathname !== "/") return refuse("unexpected_part");

  const seen = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!(PARAMS as readonly string[]).includes(key)) return refuse("unknown_parameter");
    if (seen.has(key)) return refuse("duplicate_parameter");
    seen.set(key, value);
  }

  const sessionId = seen.get("session_id");
  if (sessionId === undefined) return refuse("missing_session_id");
  if (!SESSION_ID.test(sessionId)) return refuse("invalid_session_id");
  const ticket = seen.get("ticket");
  if (ticket === undefined) return refuse("missing_ticket");
  if (!TICKET.test(ticket)) return refuse("invalid_ticket");
  const dialMode = seen.get("dial_mode");
  if (dialMode === undefined) return refuse("missing_dial_mode");
  if (!isDialMode(dialMode)) return refuse("invalid_dial_mode");

  return { ok: true, link: new StartLink(sessionId, ticket, dialMode) };
}

/**
 * The deep link among the process arguments (Windows passes it on the command line, to a first start or
 * to `second-instance`), or null. The caller must not log argv (D-147).
 */
export function findDeepLinkInArgv(argv: readonly string[]): string | null {
  const prefix = `${DEEP_LINK_SCHEME}:`;
  return argv.find((a) => typeof a === "string" && a.toLowerCase().startsWith(prefix)) ?? null;
}
