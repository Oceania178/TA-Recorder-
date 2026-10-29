// Locks the recorder pages down: no network (P7), only mic + system-audio permissions for our own pages,
// no navigation, no new windows. System audio comes from Windows loopback through getDisplayMedia.
import { app, desktopCapturer, session } from "electron";
import { pathToFileURL } from "node:url";
import { isAllowedRendererRequest } from "./networkGuard";

export function isOwnPage(url: string, rendererDir: string): boolean {
  const base = pathToFileURL(rendererDir).href.toLowerCase();
  return url.toLowerCase().startsWith(base + "/");
}

export function applySecurityPolicy(rendererDir: string): void {
  const ses = session.defaultSession;

  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRendererRequest(details.url) });
  });

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    const own = isOwnPage(webContents.getURL(), rendererDir);
    callback(own && (permission === "media" || permission === "display-capture"));
  });
  ses.setPermissionCheckHandler((webContents, permission) => {
    return !!webContents && isOwnPage(webContents.getURL(), rendererDir) && permission === "media";
  });

  // getDisplayMedia in the recorder page lands here: grant the screen (the page stops the video track
  // at once) plus 'loopback' = everything Windows plays on the default output device.
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (!isOwnPage(request.frame?.url ?? "", rendererDir)) {
        callback({});
        return;
      }
      desktopCapturer
        .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => callback(sources[0] ? { video: sources[0], audio: "loopback" } : {}))
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );

  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}
