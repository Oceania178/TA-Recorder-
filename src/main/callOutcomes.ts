// P11 (UX round 2): one quiet Windows notification when a Solace call is Sent, or Failed. The words carry only
// the call's time: never a name, a path, a ticket or any transcript text. Local only calls stay quiet.
import type { CallRow } from "./callsView";

const pad = (n: number) => String(n).padStart(2, "0");

/** The call's start as hh:mm on this laptop's clock; "" when the time cannot be read. */
export function callTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface Outcome {
  id: string;
  /** choose: a mono import is transcribed and waits for the TA's voice choice (D-171). */
  outcome: "sent" | "failed" | "choose";
  title: string;
  body: string;
}

const TITLE = "TA Call Recorder";

export class OutcomeWatcher {
  private seeded = false;
  private readonly stage = new Map<string, CallRow["stage"]>();
  private readonly told = new Set<string>();

  /** Rows as Recent calls shows them. The first call only remembers what is there (nothing old is announced). */
  update(rows: readonly CallRow[]): Outcome[] {
    const out: Outcome[] = [];
    for (const r of rows) {
      const before = this.stage.get(r.id);
      this.stage.set(r.id, r.stage);
      const choose = r.needsSpeakers === true;
      const outcome = choose ? "choose" : r.stage === "Sent" ? "sent" : r.stage === "Failed" ? "failed" : null;
      // Sent / Failed only for Solace calls; the voice choice for every import (nothing goes on without it).
      if (!outcome || (!r.linked && !choose) || (before === r.stage && !choose)) continue;
      const key = `${r.id}:${outcome}`;
      if (!this.seeded) {
        this.told.add(key);
        continue;
      }
      if (this.told.has(key)) continue;
      this.told.add(key);
      const time = callTime(r.startedAt);
      const call = time ? `Call of ${time}` : "A call";
      out.push({
        id: r.id,
        outcome,
        title: TITLE,
        body: outcome === "sent"
          ? `${call} sent to Solace.`
          : outcome === "failed"
            ? `${call} could not be sent to Solace. Open TA Call Recorder to see why.`
            : `${call} is transcribed. Open TA Call Recorder and choose which voice is yours.`,
      });
    }
    this.seeded = true;
    return out;
  }
}
