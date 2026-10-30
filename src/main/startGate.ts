// A local start from the tray or a shortcut (APP review I1, M4; D-165). Refused until the D-126 notice is
// accepted (and the set-up check opens); then refused unless Test mode is on (D-165: the installed app records
// only when opened from Solace's button); refused while a call runs (D-39); otherwise any Solace session still
// armed from a link is dropped first, so this start can never turn into that linked call.
import { ALREADY_RECORDING_MESSAGE } from "./sessionGuard";
import { NOTICE_FIRST_MESSAGE } from "./deepLinkFlow";

/** D-165: what a start without a Solace session says while Test mode is off. */
export const TEST_MODE_OFF_MESSAGE =
  "Start the call from Solace (Call & record). To record without Solace, turn on Test mode in Settings.";

export interface LocalStartDeps {
  noticeAccepted(): boolean;
  /** D-165: Test mode is on in Settings. */
  testMode(): boolean;
  isRecording(): boolean;
  /** Drop a Solace session armed by a link. */
  disarm(): void;
  /** Press Start in the recorder page. */
  start(): void;
  refuse(message: string, openWizard: boolean): void;
}

export function requestLocalStart(d: LocalStartDeps): void {
  if (!d.noticeAccepted()) return d.refuse(NOTICE_FIRST_MESSAGE, true);
  if (!d.testMode()) return d.refuse(TEST_MODE_OFF_MESSAGE, false);
  if (d.isRecording()) return d.refuse(ALREADY_RECORDING_MESSAGE, false);
  d.disarm();
  d.start();
}

