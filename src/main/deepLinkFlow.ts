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
import { parseDeepLink, type CheckResult, type DialMode } from "../core";
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
  | "bad_link" | "busy" | "no_address" | "already_recorded" | "refused" | "already_used" | "bad_address" | "unreachable" | "unexpected";

export type LinkOutcome =
  | { ok: true; session: LinkedSession; reused: boolean; message: string }
  | { ok: false; code: LinkRefusal; message: string };

export interface DeepLinkFlowDeps {
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
export const BAD_LINK_MESSAGE = "This link can't start a recording.";

const REFUSALS: Record<Exclude<LinkRefusal, "bad_link" | "busy">, string> = {
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
    const message = code === "bad_link" ? BAD_LINK_MESSAGE : code === "busy" ? ALREADY_RECORDING_MESSAGE : REFUSALS[code];
    return { ok: false, code, message };
  }

  private begin(session: LinkedSession, reused: boolean): LinkOutcome {
    this.d.start(session);
    this.d.log?.("link.started", { reused, dial_mode: session.dialMode });
    return { ok: true, session, reused, message: startedMessage(session.dialMode) };
  }

  async handle(url: unknown): Promise<LinkOutcome> {
    const parsed = parseDeepLink(url);
    if (!parsed.ok) return this.refuse("bad_link");
    const link = parsed.link;
    if (!isValidCallId(link.sessionId)) return this.refuse("bad_link");
    if (this.checking || this.d.isRecording()) return this.refuse("busy");
    if (this.d.alreadyRecorded(link.sessionId)) return this.refuse("already_recorded");
    const baseUrl = this.d.getBaseUrl();
    if (!baseUrl) return this.refuse("no_address");

    this.checking = true;
    try {
      const now = (this.d.now ?? Date.now)();
      const held = await this.d.tickets.held(link.sessionId);
      if (held && Date.parse(held.sendBy) > now) {
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
      await this.d.tickets.save(session.sessionId, r.uploadTicket.reveal(), { sendBy: r.sendBy, dialMode: r.dialMode });
      if (this.d.isRecording()) return this.refuse("busy");
      return this.begin(session, false);
    } finally {
      this.checking = false;
    }
  }
}
