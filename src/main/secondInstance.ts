// What the running app does when Windows starts it again (second-instance). The command line is never
// logged: it can carry a Solace link with a ticket (D-147).
// - `--sweep` (the logon cleanup task while the app is open): sweep, nothing else, no window.
// - a tacallrecorder:// link: hand it on untouched, then show the window.
// - anything else (the TA opened the app again): show the window.
import { findDeepLinkArg } from "./deepLinkHook";
import { isSweepMode } from "./sweepMode";

export interface SecondInstanceDeps {
  sweep(): void;
  deepLink(url: string): void;
  show(): void;
  log?(event: string, fields: Record<string, unknown>): void;
}

export function handleSecondInstance(argv: readonly string[], d: SecondInstanceDeps): void {
  if (isSweepMode(argv)) {
    d.log?.("second_instance.sweep", {});
    d.sweep();
    return;
  }
  const url = findDeepLinkArg(argv);
  if (url) {
    d.log?.("second_instance.link", {});
    d.deepLink(url);
  }
  d.show();
}
