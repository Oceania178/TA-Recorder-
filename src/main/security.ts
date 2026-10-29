// Locks the recorder pages down: no network (P7), only mic + system-audio permissions for our own pages,
// no navigation, no new windows. System audio comes from Windows loopback through getDisplayMedia.
// The rules themselves are pure and tested in pagePolicy.ts (APP review M10, M11).
import { app, desktopCapturer, session } from "electron";
import { isAllowedRendererRequest, isOwnPage, permissionAllowed, permissionCheckAllowed } from "./pagePolicy";

export { isOwnPage };

export function applySecurityPolicy(rendererDir: string): void {
  const ses = session.defaultSession;

  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRendererRequest(details.url, rendererDir) });
  });

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const own = isOwnPage(webContents.getURL(), rendererDir);
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
    callback(permissionAllowed(permission, mediaTypes, own));
  });
  ses.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    const own = !!webContents && isOwnPage(webContents.getURL(), rendererDir);
    return permissionCheckAllowed(permission, (details as { mediaType?: string }).mediaType, own);
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
