// What the app's own pages may load and ask for (P7, APP review M10 / M11). Pure: security.ts applies it.
// - A page is "own" only when its file:// URL is inside the renderer folder (a folder named like it, a
//   network share or a web page is not).
// - Pages may load only the app's own files, plus in-memory data (data:, blob:) and devtools. Everything
//   else — web, ws, other local files, \\server\share — is cancelled.
// - Permissions: the microphone (audio only, never a camera) and system-audio capture (getDisplayMedia, which
//   Electron asks as "media" with no media types; it always includes a screen, whose video track the page
//   stops at once). Nothing else.
import { pathToFileURL } from "node:url";

function folderPath(rendererDir: string): string {
  const href = pathToFileURL(rendererDir).href.replace(/\/?$/, "/");
  return decodeURIComponent(new URL(href).pathname).toLowerCase();
}

/** True when `url` is a file:// URL inside the renderer folder (case-insensitive, Windows). */
export function isOwnPage(url: string, rendererDir: string): boolean {
  if (typeof url !== "string") return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "file:" || u.host !== "") return false;
  const path = decodeURIComponent(u.pathname).toLowerCase();
  const base = folderPath(rendererDir);
  return path.startsWith(base) && !path.slice(base.length).split("/").includes("..");
}

const IN_MEMORY = new Set(["data:", "blob:", "devtools:"]);

export function isAllowedRendererRequest(url: string, rendererDir: string): boolean {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return false;
  }
  if (IN_MEMORY.has(protocol)) return true;
  return protocol === "file:" && isOwnPage(url, rendererDir);
}

/** A permission request (`mediaTypes` from Electron's details). */
export function permissionAllowed(permission: string, mediaTypes: readonly string[] | undefined, own: boolean): boolean {
  if (!own) return false;
  if (permission === "display-capture") return true;
  // getUserMedia asks with ["audio"]; getDisplayMedia (system audio) asks with an empty list and is then
  // answered by the display-media handler, which grants only the screen + loopback to our own pages.
  // Any request naming video (a camera) is refused.
  if (permission === "media") return Array.isArray(mediaTypes) && mediaTypes.every((t) => t === "audio");
  return false;
}

/** A permission check (`mediaType` from Electron's details). */
export function permissionCheckAllowed(permission: string, mediaType: string | undefined, own: boolean): boolean {
  return own && permission === "media" && mediaType !== "video";
}
