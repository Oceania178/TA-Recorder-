// Step 5 (app part): Solace's "Call & record" button opens tacallrecorder://start?session_id&ticket&dial_mode.
// 1. Parse it strictly (core). A bad link: "This link can't start a recording." — the link is never logged
//    or repeated (it carries a ticket, D-147).
// 2. One call at a time (D-39): refuse while recording, or while another link is being checked.
// 3. No pinned Solace address yet: refuse and point to Settings (D-143: the link never says where to send).
// 4. If this session was already checked and its upload ticket is held (the browser opened the same link
//    twice), reuse it — a second check would only answer "already checked" (D-147).
// 5. Otherwise check the ticket at the pinned address (step ①b). Only an "ok" starts a recording; anything
//    else is explained in plain words and nothing is recorded.
// Pure logic: Electron, the network and the secret store are passed in.
import { createHash } from "node:crypto";
import { parseDeepLink, validateSolaceBaseUrl, type CheckResult, type DialMode } from "../core";
import { isValidCallId } from "./callId";
import type { HeldTicket } from "./secretStore";
import { ALREADY_RECORDING_MESSAGE } from "./sessionGuard";

export interface LinkedSession {
  sessionId: string;
  dialMode: DialMode;
  /** Solace's upload_until (ISO): the transcript must be sent before this (D-144). */
  sendBy: string;
}

export type LinkRefusal =
  | "notice" | "bad_link" | "busy" | "no_address" | "already_recorded" | "refused" | "already_used" | "bad_address" | "unreachable" | "unexpected";

export type LinkOutcome =
  | { ok: true; session: LinkedSession; reused: boolean; message: string; clockWarning: string | null }
  | { ok: false; code: LinkRefusal; message: string };

export interface DeepLinkFlowDeps {
  /** D-126: nothing records until the TA accepted the notice (wizard step 1). */
  noticeAccepted(): boolean;
  isRecording(): boolean;
  getBaseUrl(): string | null;
  /** core's checkTicket bound to fetch (and the dev flag). */
  checkTicket(baseUrl: string, sessionId: string, linkTicket: string): Promise<CheckResult>;
  tickets: {
    held(sessionId: string): Promise<HeldTicket | null>;
    save(sessionId: string, uploadTicket: string, held: HeldTicket): Promise<void>;
  };
  /** True when this session already has a recording (its folder exists or it is queued). */
  alreadyRecorded(sessionId: string): boolean;
  /** Start recording this session now (main: arm the controller, then press Start in the recorder page). */
  start(session: LinkedSession): void;
  now?: () => number;
  log?(event: string, fields: Record<string, unknown>): void;
}

const NOTHING = "Nothing was recorded.";
/** APP review I1: every start is refused until the D-126 notice is accepted. */
export const NOTICE_FIRST_MESSAGE = "Open Set-up check and accept the notice first.";
/** Solace's clock and the laptop's may differ by this much before the TA is warned. */
const CLOCK_TOLERANCE_MS = 2 * 60_000;

/** sha256 of the link ticket: lets a reopened link prove it is the same link, without keeping the ticket. */
export function hashLinkTicket(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

/** A warning when Solace's server_time and this laptop differ by more than 2 minutes, else null. */
export function clockWarning(serverTime: string | null, nowMs: number): string | null {
  const server = serverTime ? Date.parse(serverTime) : NaN;
  if (Number.isNaN(server)) return null;
  const off = Math.abs(server - nowMs);
  if (off <= CLOCK_TOLERANCE_MS) return null;
  return `Your laptop clock is off by ${Math.round(off / 60_000)} min, so Solace may reject the call. Fix it in Windows Settings → Time & language → Date & time → Sync now.`;
}
export const BAD_LINK_MESSAGE = "This link can't start a recording.";

const REFUSALS: Record<Exclude<LinkRefusal, "bad_link" | "busy" | "notice">, string> = {
  no_address: `The Solace address is not set yet. Open Settings (or the set-up check, step 4) and enter it, then press "Call & record" in Solace again. ${NOTHING}`,
  already_recorded: `This Solace call has already been recorded. Press "Call & record" in Solace again for a new call. ${NOTHING}`,
  refused: `Solace did not accept this link (it may be more than 30 minutes old or already used). Press "Call & record" in Solace again. ${NOTHING}`,
  already_used: `This link was already used. Press "Call & record" in Solace again for a new link. ${NOTHING}`,
  bad_address: `The Solace address in Settings cannot be used. Check it in Settings. ${NOTHING}`,
  unreachable: `Solace could not be reached (no network, or Solace is busy). Check the connection and press "Call & record" again. ${NOTHING}`,
  unexpected: `Solace gave an unexpected answer. Try "Call & record" again; if it keeps happening, tell the Solace admin. ${NOTHING}`,
};

function startedMessage(dialMode: DialMode): string {
  return dialMode === "self_dial"
    ? "Linked to Solace. Recording starts now — dial the candidate yourself (Zalo, Teams…)."
    : "Linked to Solace. Recording starts now — 3CX dials the candidate.";
}

export class DeepLinkFlow {
  private checking = false;

  constructor(private readonly d: DeepLinkFlowDeps) {}

  private refuse(code: LinkRefusal): LinkOutcome {
    this.d.log?.("link.refused", { reason: code });
    const message = code === "notice" ? NOTICE_FIRST_MESSAGE : code === "bad_link" ? BAD_LINK_MESSAGE : code === "busy" ? ALREADY_RECORDING_MESSAGE : REFUSALS[code];
    return { ok: false, code, message };
  }

  private begin(session: LinkedSession, reused: boolean, warning: string | null = null): LinkOutcome {
    this.d.start(session);
    this.d.log?.("link.started", { reused, dial_mode: session.dialMode, clock_off: warning !== null });
    return { ok: true, session, reused, message: startedMessage(session.dialMode), clockWarning: warning };
  }

  async handle(url: unknown): Promise<LinkOutcome> {
    const parsed = parseDeepLink(url);
    if (!parsed.ok) return this.refuse("bad_link");
    if (!this.d.noticeAccepted()) return this.refuse("notice");
    const link = parsed.link;
    if (!isValidCallId(link.sessionId)) return this.refuse("bad_link");
    if (this.checking || this.d.isRecording()) return this.refuse("busy");
    if (this.d.alreadyRecorded(link.sessionId)) return this.refuse("already_recorded");
    const baseUrl = this.d.getBaseUrl();
    if (!baseUrl) return this.refuse("no_address");

    this.checking = true;
    try {
      const now = (this.d.now ?? Date.now)();
      const linkHash = hashLinkTicket(link.revealTicket());
      const held = await this.d.tickets.held(link.sessionId);
      // Reuse only for the very link that was checked (APP review M3): any other ticket goes to Solace.
      if (held && Date.parse(held.sendBy) > now && held.linkTicketHash === linkHash) {
        if (this.d.isRecording()) return this.refuse("busy");
        return this.begin({ sessionId: link.sessionId, dialMode: held.dialMode, sendBy: held.sendBy }, true);
      }

      const r = await this.d.checkTicket(baseUrl, link.sessionId, link.revealTicket());
      if (!r.ok) {
        const code: LinkRefusal =
          r.kind === "refused" ? "refused"
          : r.kind === "already_checked" ? "already_used"
          : r.kind === "bad_address" ? "bad_address"
          : r.kind === "retryable" ? "unreachable"
          : "unexpected";
        return this.refuse(code);
      }
      const session: LinkedSession = { sessionId: r.sessionId, dialMode: r.dialMode, sendBy: r.sendBy };
      // Keep the upload ticket first: if a recording started meanwhile, opening the link again reuses it.
      // The origin it was checked at goes with it: the transcript is sent only there (APP review M2).
      const origin = validateSolaceBaseUrl(baseUrl, { dev: true });
      await this.d.tickets.save(session.sessionId, r.uploadTicket.reveal(), {
        sendBy: r.sendBy, dialMode: r.dialMode, origin: origin.ok ? origin.url : baseUrl, linkTicketHash: linkHash,
      });
      if (this.d.isRecording()) return this.refuse("busy");
      return this.begin(session, false, clockWarning(r.serverTime, now));
    } finally {
      this.checking = false;
    }
  }
}
