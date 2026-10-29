// The app's own network calls (Gemini, the Solace ticket check and upload, the wizard's health check) go
// through Chromium's network stack (APP review M12): it follows the Windows proxy settings and trusts the
// Windows certificate store, as a company network with a proxy or TLS inspection needs. Node's fetch does not.
// They use their own in-memory session: the pages' default session blocks every network request (P7), and
// this one holds no cookies or cache on disk and serves no page.
// Redirects are still refused by core (fetchWithTimeout sets redirect: "error").
import { session } from "electron";
import type { FetchLike, ResponseLike } from "../core";

const PARTITION = "ta-call-recorder-net";

export function createNetFetch(): FetchLike {
  const ses = session.fromPartition(PARTITION, { cache: false });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  return (url, init) => ses.fetch(url, init as RequestInit) as unknown as Promise<ResponseLike>;
}
