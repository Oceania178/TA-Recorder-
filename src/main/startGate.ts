// A local start from the tray or a shortcut (APP review I1, M4). Refused until the D-126 notice is accepted
// (and the set-up check opens), refused while a call runs (D-39); otherwise any Solace session still armed
// from a link is dropped first, so this start can never turn into that linked call.
import { ALREADY_RECORDING_MESSAGE } from "./sessionGuard";
import { NOTICE_FIRST_MESSAGE } from "./deepLinkFlow";

export interface LocalStartDeps {
  noticeAccepted(): boolean;
  isRecording(): boolean;
  /** Drop a Solace session armed by a link. */
  disarm(): void;
  /** Press Start in the recorder page. */
  start(): void;
  refuse(message: string, openWizard: boolean): void;
}

export function requestLocalStart(d: LocalStartDeps): void {
  if (!d.noticeAccepted()) return d.refuse(NOTICE_FIRST_MESSAGE, true);
  if (d.isRecording()) return d.refuse(ALREADY_RECORDING_MESSAGE, false);
  d.disarm();
  d.start();
}
