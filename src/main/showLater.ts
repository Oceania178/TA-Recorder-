// Windows notifications are shown on the next task, never inside the one that handles a second instance.
// Found in UX round 2 (02/11/2026): with Electron 33 on Windows, showing a notification while the app handles a
// second instance (a Solace link refused at once) crashes the app when any notification was shown before.
// A probe against the dev build crashed every time without the delay and never with it.
const DELAY_MS = 50;

export function showLater(show: () => void, schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms)): void {
  schedule(show, DELAY_MS);
}
