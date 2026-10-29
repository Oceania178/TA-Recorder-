// Step 5 (app part): a tacallrecorder:// link → ticket check at the pinned address → recording linked to Solace.
import { describe, expect, it } from "vitest";
import { DeepLinkFlow, type DeepLinkFlowDeps, type LinkedSession } from "../../src/main/deepLinkFlow";
import { Secret, type CheckResult } from "../../src/core";
import type { HeldTicket } from "../../src/main/secretStore";

const SID = "cmh2x9k0a0001qz8v7y6t5r4e";
const LINK_TICKET = "L".repeat(43);
const UPLOAD_TICKET = "U".repeat(43);
const SOLACE = "https://solace.vng.vn";
const NOW = Date.parse("2026-10-29T03:00:00Z");
const SEND_BY = "2026-11-01T03:00:00.000Z";
const link = (over: Record<string, string> = {}) => {
  const p = new URLSearchParams({ session_id: SID, ticket: LINK_TICKET, dial_mode: "3cx", ...over });
  return `tacallrecorder://start?${p.toString()}`;
};

function setup(o: { recording?: boolean; baseUrl?: string | null; check?: CheckResult | (() => Promise<CheckResult>); held?: HeldTicket; recorded?: boolean } = {}) {
  const checks: { baseUrl: string; sessionId: string; ticket: string }[] = [];
  const saved: { sessionId: string; ticket: string; held: HeldTicket }[] = [];
  const started: LinkedSession[] = [];
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const held = new Map<string, HeldTicket>(o.held ? [[SID, o.held]] : []);
  let recording = o.recording ?? false;
  const deps: DeepLinkFlowDeps = {
    isRecording: () => recording,
    getBaseUrl: () => (o.baseUrl === undefined ? SOLACE : o.baseUrl),
    checkTicket: async (baseUrl, sessionId, ticket) => {
      checks.push({ baseUrl, sessionId, ticket });
      const c = o.check ?? { ok: true, sessionId: SID, dialMode: "3cx", uploadTicket: new Secret(UPLOAD_TICKET), sendBy: SEND_BY, serverTime: null };
      return typeof c === "function" ? c() : c;
    },
    tickets: {
      held: async (id) => held.get(id) ?? null,
      save: async (sessionId, ticket, h) => {
        saved.push({ sessionId, ticket, held: h });
        held.set(sessionId, h);
      },
    },
    alreadyRecorded: () => o.recorded ?? false,
    start: (s) => {
      started.push(s);
      recording = true;
    },
    now: () => NOW,
    log: (event, fields) => logs.push({ event, fields }),
  };
  return { flow: new DeepLinkFlow(deps), checks, saved, started, logs, setRecording: (v: boolean) => (recording = v) };
}

describe("deep link → recording", () => {
  it("checks the ticket at the pinned address, keeps the upload ticket, and starts a linked recording", async () => {
    const t = setup();
    const r = await t.flow.handle(link());
    expect(r.ok).toBe(true);
    expect(t.checks).toEqual([{ baseUrl: SOLACE, sessionId: SID, ticket: LINK_TICKET }]);
    expect(t.saved).toEqual([{ sessionId: SID, ticket: UPLOAD_TICKET, held: { sendBy: SEND_BY, dialMode: "3cx" } }]);
    expect(t.started).toEqual([{ sessionId: SID, dialMode: "3cx", sendBy: SEND_BY }]);
  });

  it("starts a self-dial recording and says the TA dials (D-133)", async () => {
    const t = setup({ check: { ok: true, sessionId: SID, dialMode: "self_dial", uploadTicket: new Secret(UPLOAD_TICKET), sendBy: SEND_BY, serverTime: null } });
    const r = await t.flow.handle(link({ dial_mode: "self_dial" }));
    expect(t.started[0].dialMode).toBe("self_dial");
    expect(r.message).toMatch(/dial .*yourself/i);
  });

  it("refuses a bad link without checking anything, and never logs or repeats it", async () => {
    const t = setup();
    const bad = `tacallrecorder://start?session_id=${SID}&ticket=${LINK_TICKET}&dial_mode=3cx&server=https://evil.example`;
    const r = await t.flow.handle(bad);
    expect(r).toMatchObject({ ok: false, code: "bad_link", message: "This link can't start a recording." });
    expect(t.checks).toHaveLength(0);
    expect(t.started).toHaveLength(0);
    expect(JSON.stringify(t.logs)).not.toContain(LINK_TICKET);
    expect(JSON.stringify(t.logs)).not.toContain("evil");
  });

  it("refuses while a call is being recorded (D-39), before any check", async () => {
    const t = setup({ recording: true });
    const r = await t.flow.handle(link());
    expect(r).toMatchObject({ ok: false, code: "busy" });
    if (!r.ok) expect(r.message).toMatch(/already recording/i);
    expect(t.checks).toHaveLength(0);
  });

  it("refuses a second link while the first is still being checked", async () => {
    let release: (c: CheckResult) => void = () => undefined;
    const t = setup({ check: () => new Promise<CheckResult>((done) => (release = done)) });
    const first = t.flow.handle(link());
    await Promise.resolve();
    const second = await t.flow.handle(link());
    expect(second).toMatchObject({ ok: false, code: "busy" });
    release({ ok: true, sessionId: SID, dialMode: "3cx", uploadTicket: new Secret(UPLOAD_TICKET), sendBy: SEND_BY, serverTime: null });
    expect((await first).ok).toBe(true);
    expect(t.checks).toHaveLength(1);
  });

  it("refuses when no Solace address is set and points to Settings", async () => {
    const t = setup({ baseUrl: null });
    const r = await t.flow.handle(link());
    expect(r).toMatchObject({ ok: false, code: "no_address" });
    if (!r.ok) expect(r.message).toMatch(/Settings/);
    expect(t.checks).toHaveLength(0);
  });

  it.each([
    [{ ok: false, kind: "refused" } as CheckResult, "refused", /Solace did not accept/],
    [{ ok: false, kind: "already_checked", sendBy: SEND_BY } as CheckResult, "already_used", /already used/],
    [{ ok: false, kind: "bad_address" } as CheckResult, "bad_address", /Settings/],
    [{ ok: false, kind: "retryable", reason: "network", retryAfterMs: null } as CheckResult, "unreachable", /could not be reached/],
    [{ ok: false, kind: "unexpected", status: 418 } as CheckResult, "unexpected", /unexpected/],
  ])("does not record when the check answers %j", async (check, code, message) => {
    const t = setup({ check });
    const r = await t.flow.handle(link());
    expect(r).toMatchObject({ ok: false, code });
    if (!r.ok) {
      expect(r.message).toMatch(message);
      expect(r.message).toMatch(/Nothing was recorded/);
    }
    expect(t.started).toHaveLength(0);
    expect(t.saved).toHaveLength(0);
  });

  it("reuses the upload ticket it already holds for the same session, without a second check", async () => {
    const t = setup({ held: { sendBy: SEND_BY, dialMode: "self_dial" } });
    const r = await t.flow.handle(link());
    expect(r.ok).toBe(true);
    expect(t.checks).toHaveLength(0);
    expect(t.started).toEqual([{ sessionId: SID, dialMode: "self_dial", sendBy: SEND_BY }]);
  });

  it("checks again when the held ticket's send window has closed", async () => {
    const t = setup({ held: { sendBy: "2026-10-01T00:00:00.000Z", dialMode: "3cx" } });
    await t.flow.handle(link());
    expect(t.checks).toHaveLength(1);
  });

  it("refuses a session that was already recorded", async () => {
    const t = setup({ recorded: true });
    const r = await t.flow.handle(link());
    expect(r).toMatchObject({ ok: false, code: "already_recorded" });
    expect(t.checks).toHaveLength(0);
  });

  it("keeps the ticket but does not start when a recording began during the check", async () => {
    let release: (c: CheckResult) => void = () => undefined;
    const t = setup({ check: () => new Promise<CheckResult>((done) => (release = done)) });
    const pending = t.flow.handle(link());
    await Promise.resolve();
    t.setRecording(true);
    release({ ok: true, sessionId: SID, dialMode: "3cx", uploadTicket: new Secret(UPLOAD_TICKET), sendBy: SEND_BY, serverTime: null });
    const r = await pending;
    expect(r).toMatchObject({ ok: false, code: "busy" });
    expect(t.saved).toHaveLength(1);
    expect(t.started).toHaveLength(0);
  });

  it("logs codes only, never the ticket or the address", async () => {
    const t = setup();
    await t.flow.handle(link());
    const text = JSON.stringify(t.logs);
    expect(text).not.toContain(LINK_TICKET);
    expect(text).not.toContain(UPLOAD_TICKET);
    expect(text).not.toContain("solace.vng.vn");
  });
});
