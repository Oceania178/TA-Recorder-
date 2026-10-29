// While `--sweep` runs (a few seconds at logon or once a day) it holds the single-instance lock. A TA who opens
// the app, or a Solace link, in those seconds lands on the sweeping process as a "second instance" (APP review 2,
// m-R5). Instead of being lost, the request is remembered, and when the sweep is done the app is started again
// with that request's own arguments (a link included). The arguments are never logged (a link carries a ticket).
import { isPurgeMode, isSweepMode } from "./sweepMode";

export class SweepHandover {
  private args: string[] | null = null;

  /** A second instance arrived during the sweep. Another sweep or a purge is not a request to open the app. */
  noteRequest(argv: readonly string[]): void {
    if (isSweepMode(argv) || isPurgeMode(argv)) return;
    this.args = argv.slice(1).filter((a): a is string => typeof a === "string");
  }

  /** The arguments to start the app with after the sweep (process.execPath + these), or null when nobody asked. */
  relaunchArgs(): string[] | null {
    return this.args ? [...this.args] : null;
  }
}
