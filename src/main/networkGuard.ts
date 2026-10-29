// P7: the recorder windows never talk to the network. Only the app's own files and in-memory data load.
const ALLOWED_PROTOCOLS = new Set(["file:", "devtools:", "data:", "blob:"]);

export function isAllowedRendererRequest(url: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
