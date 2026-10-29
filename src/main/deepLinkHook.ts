// Receives tacallrecorder:// links (from Solace's "Call & record" button) and hands them on, untouched.
// This file does not parse or act on the link: core (deepLink.ts) and APP-C do that.
// The link carries a ticket (D-147): never log it, never put it in an error message.

const SCHEME = "tacallrecorder:";

type Handler = (url: string) => void;
let handler: Handler | null = null;
let pending: string | null = null;

/** The link Windows passes on the command line, if any. */
export function findDeepLinkArg(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === "string" && arg.toLowerCase().startsWith(SCHEME)) return arg;
  }
  return null;
}

/** APP-C wires this to core. A link that arrived earlier is delivered once, now. */
export function setDeepLinkHandler(next: Handler | null): void {
  handler = next;
  if (handler && pending !== null) {
    const url = pending;
    pending = null;
    handler(url);
  }
}

/** Called by main for every link received (first launch or a second instance). */
export function onDeepLink(url: string): void {
  if (handler) handler(url);
  else pending = url;
}
