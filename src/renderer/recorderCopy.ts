// The recorder window's words that depend on state (UX pass 02/11/2026). Plain functions, so they can be tested.
// Button names are written the way Solace names them ("Call & record", "Record only, I'll call myself").

/** The D-126 refusal as the window shows it (the same words as main's NOTICE_FIRST_MESSAGE in deepLinkFlow.ts). */
export const NOTICE_FIRST_MESSAGE = "Open Set-up check and accept the notice first.";

/** The line under Start: what the TA does next to record a call. */
export function startHint(testMode: boolean, shortcut: string): string {
  return testMode
    ? `Test mode is on: Start, the tray or ${shortcut} records a "Local only" call. It is transcribed on this laptop and never sent to Solace. Calls from Solace work as usual.`
    : `To record a call, press "Call & record" (or "Record only, I'll call myself") on the candidate in Solace. This app starts recording by itself. To use a recording you already have, press "Import a recording instead…" once it has started.`;
}

/** Start is the main (blue) button only when it can record: in Test mode. Otherwise the call starts in Solace. */
export function startIsPrimary(testMode: boolean): boolean {
  return testMode;
}

/** "Accept the notice first" no longer applies once the notice is accepted. */
export function isStaleNoticeMessage(text: string, noticeAccepted: boolean): boolean {
  return noticeAccepted && text === NOTICE_FIRST_MESSAGE;
}

/** Next to Start: why nothing can be recorded while the recordings folder cannot be used, and where to fix it. */
export function folderBanner(problem: string | null): string | null {
  return problem ? `Recording is off. ${problem} Fix it in Settings → Recordings folder → Change…` : null;
}
