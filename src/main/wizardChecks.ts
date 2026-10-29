// Checks behind the first-run wizard (D-132, spec §8.23). Pure: fetch is passed in.
// Step 4 tests the Solace address with Solace's public, unauthenticated, content-free health route
// (GET /api/health → { ok: true, service: "vngg-ats", … }). It never sends a ticket: the ticket check is only
// ever made with a real ticket from Solace's "Call & record" button, which is the real end-to-end test.
import { validateSolaceBaseUrl, type FetchLike } from "../core";
import { fetchWithTimeout, isObject, readJson } from "../core/http";

/** Step 2: Windows Settings → Privacy & security → Microphone. A fixed address; nothing else is opened. */
export const WINDOWS_MIC_SETTINGS = "ms-settings:privacy-microphone";
export const SOLACE_HEALTH_PATH = "/api/health";

export type AddressTest = {
  ok: boolean;
  /** solace = Solace answered; https_only = something answered over https, but not Solace's health route. */
  level: "solace" | "https_only" | "invalid" | "unreachable";
  url?: string;
  message: string;
};

const REAL_TEST = 'The real test is Solace\'s "Call & record" button: press it on a candidate and the app should start recording.';

export async function testSolaceAddress(fetch: FetchLike, raw: unknown, o: { dev?: boolean; timeoutMs?: number } = {}): Promise<AddressTest> {
  const v = validateSolaceBaseUrl(raw, { dev: o.dev });
  if (!v.ok) return { ok: false, level: "invalid", message: "Enter an https address with nothing after the name, e.g. https://solace.example.vn" };
  try {
    const res = await fetchWithTimeout(fetch, `${v.url}${SOLACE_HEALTH_PATH}`, { method: "GET", headers: { Accept: "application/json" } }, o.timeoutMs ?? 10_000);
    const body = res.status === 200 ? await readJson(res) : null;
    if (isObject(body) && body.ok === true && body.service === "vngg-ats") {
      return { ok: true, level: "solace", url: v.url, message: `Solace answered at this address. ${REAL_TEST}` };
    }
    return { ok: true, level: "https_only", url: v.url, message: `The address answers over https, but it did not identify itself as Solace. ${REAL_TEST}` };
  } catch {
    return { ok: false, level: "unreachable", url: v.url, message: "No answer from this address. Check the spelling and the network (VPN?), then test again." };
  }
}

/** Step 5's "Test dial": a tel: link from a plain phone number the TA typed (digits, spaces, one leading +). */
export function telLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!/^\+?[0-9 ]+$/.test(text)) return null;
  const compact = text.replace(/ /g, "");
  const digits = compact.replace("+", "");
  if (digits.length < 3 || digits.length > 15) return null;
  return `tel:${compact}`;
}
