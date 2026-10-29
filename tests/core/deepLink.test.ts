import { describe, it, expect } from "vitest";
import { inspect } from "node:util";
import { parseDeepLink, findDeepLinkInArgv } from "../../src/core/deepLink";

const SID = "cmh2x9k0a0001qz8v7y6t5r4e";
const TICKET = "Qm9vbS1ib29tLXRoaXMtaXMtYS0zMi1ieXRlLXRpY2tldA";
const link = (q: string) => `tacallrecorder://start?${q}`;
const good = link(`session_id=${SID}&ticket=${TICKET}&dial_mode=3cx`);

describe("parseDeepLink — accepts", () => {
  it("the link Solace builds (sessions.routes.ts deepLink())", () => {
    const r = parseDeepLink(good);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.link.sessionId).toBe(SID);
    expect(r.link.dialMode).toBe("3cx");
    expect(r.link.revealTicket()).toBe(TICKET);
  });

  it("self_dial, parameters in any order, and the trailing slash Windows sometimes adds", () => {
    const r = parseDeepLink(`tacallrecorder://start/?dial_mode=self_dial&ticket=${TICKET}&session_id=${SID}`);
    expect(r.ok && r.link.dialMode).toBe("self_dial");
  });

  it("the scheme in any case", () => {
    expect(parseDeepLink(good.replace("tacallrecorder", "TACallRecorder")).ok).toBe(true);
  });
});

describe("parseDeepLink — refuses, with a reason", () => {
  const cases: Array<[string, unknown, string]> = [
    ["not a string", 42, "not_a_string"],
    ["too long", link(`session_id=${SID}&ticket=${"a".repeat(3000)}&dial_mode=3cx`), "too_long"],
    ["junk", "hello world", "not_a_url"],
    ["another scheme", good.replace("tacallrecorder", "https"), "wrong_scheme"],
    ["another action", good.replace("//start", "//stop"), "wrong_action"],
    ["a path", good.replace("//start?", "//start/evil?"), "unexpected_part"],
    ["a fragment", `${good}#x`, "unexpected_part"],
    ["credentials", good.replace("//start", "//u:p@start"), "unexpected_part"],
    ["a port", good.replace("//start", "//start:99"), "unexpected_part"],
    ["a Solace address smuggled in (D-143)", `${good}&base_url=https://evil.example`, "unknown_parameter"],
    ["a repeated parameter", `${good}&dial_mode=self_dial`, "duplicate_parameter"],
    ["no session", link(`ticket=${TICKET}&dial_mode=3cx`), "missing_session_id"],
    ["a session id with odd characters", link(`session_id=abc%2F..%2F..&ticket=${TICKET}&dial_mode=3cx`), "invalid_session_id"],
    ["a session id too short", link(`session_id=abc&ticket=${TICKET}&dial_mode=3cx`), "invalid_session_id"],
    ["no ticket", link(`session_id=${SID}&dial_mode=3cx`), "missing_ticket"],
    ["a ticket too short", link(`session_id=${SID}&ticket=short&dial_mode=3cx`), "invalid_ticket"],
    ["a ticket with spaces", link(`session_id=${SID}&ticket=${TICKET}%20x&dial_mode=3cx`), "invalid_ticket"],
    ["no dial mode", link(`session_id=${SID}&ticket=${TICKET}`), "missing_dial_mode"],
    ["another dial mode", link(`session_id=${SID}&ticket=${TICKET}&dial_mode=zalo`), "invalid_dial_mode"],
  ];
  for (const [name, input, reason] of cases) {
    it(name, () => {
      const r = parseDeepLink(input);
      expect(r).toEqual({ ok: false, reason });
    });
  }
});

describe("the ticket never shows in a string a caller could log (D-147)", () => {
  const r = parseDeepLink(good);
  if (!r.ok) throw new Error("expected ok");
  const l = r.link;

  it("String(), template literals, JSON and util.inspect hide it", () => {
    for (const s of [String(l), `${l}`, JSON.stringify(l), JSON.stringify({ l }), inspect(l), inspect({ nested: l }, { depth: 5 })]) {
      expect(s).not.toContain(TICKET);
      expect(s).toContain(SID); // the session id is fine to log
    }
  });

  it("the ticket is not an enumerable property", () => {
    expect(Object.values(l)).not.toContain(TICKET);
    expect({ ...l }).not.toHaveProperty("ticket");
  });

  it("a refusal never repeats the input", () => {
    const bad = parseDeepLink(link(`session_id=${SID}&ticket=${TICKET}&dial_mode=zalo`));
    expect(JSON.stringify(bad)).not.toContain(TICKET);
  });
});

describe("findDeepLinkInArgv", () => {
  it("finds the deep link among Electron's arguments", () => {
    expect(findDeepLinkInArgv(["C:\\app.exe", "--flag", good])).toBe(good);
    expect(findDeepLinkInArgv(["C:\\app.exe", "TACALLRECORDER://start?x=1"])).toBe("TACALLRECORDER://start?x=1");
  });
  it("gives null when there is none", () => {
    expect(findDeepLinkInArgv(["C:\\app.exe", "--hidden"])).toBeNull();
  });
});
