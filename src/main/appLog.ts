// A small log file in the app data folder (app.log), for counts and stages only.
// Never: transcript text, tickets, keys, links (they carry tickets), folder paths, error messages.
// Every field goes through sanitiseFields, which keeps only numbers, booleans, short lowercase codes
// (e.g. "no_gemini_key", "transcribed") and a call id under the key "id"; anything else becomes "[redacted]".
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

export type LogFields = Record<string, unknown>;
export type LogValue = number | boolean | string | null;
export type LogFn = (event: string, fields?: LogFields) => void;

const REDACTED = "[redacted]";
const EVENT = /^[a-z][a-z0-9_.]{0,47}$/;
const KEY = /^[a-z][a-z0-9_]{0,31}$/;
/**
 * Codes such as stage names and failure reasons: lowercase words joined by "_" ("no_gemini_key"), or the
 * dial mode "3cx". At most 31 characters, so no ticket (32+) or key can ever pass, and a session id (letters
 * mixed with digits) does not look like a code.
 */
const CODE = /^(?:[a-z]+(?:_[a-z0-9]+)*|3cx)$/;
const MAX_CODE = 31;
/**
 * A call id: the local id (20261029-140305-a1b2c3) or a Solace session id (a 25-character cuid).
 * Tickets are at least 32 characters (core's deep-link parser), so capping at 31 means a ticket can
 * never pass as an id, even under the key "id".
 */
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,30}$/;
const DEFAULT_MAX_BYTES = 256 * 1024;

function cleanValue(key: string, value: unknown): LogValue {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : REDACTED;
  if (typeof value === "string") {
    if (key === "id" && CALL_ID.test(value)) return value;
    if (value.length <= MAX_CODE && CODE.test(value)) return value;
  }
  return REDACTED;
}

export function sanitiseFields(fields: LogFields): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (!KEY.test(key)) continue;
    out[key] = cleanValue(key, value);
  }
  return out;
}

export function formatLogLine(at: Date, event: string, fields: LogFields): string {
  const name = EVENT.test(event) ? event : "invalid_event";
  return `${at.toISOString()} ${name} ${JSON.stringify(sanitiseFields(fields))}\n`;
}

export class AppLog {
  private writing: Promise<void> = Promise.resolve();
  private readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(private readonly o: { file: string; maxBytes?: number; now?: () => Date }) {
    this.maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = o.now ?? (() => new Date());
  }

  /** Fire and forget: a log write never blocks or breaks the app. */
  event(name: string, fields: LogFields = {}): void {
    const line = formatLogLine(this.now(), name, fields);
    this.writing = this.writing.then(() => this.write(line)).catch(() => undefined);
  }

  /** Resolves once every line asked for so far is written (tests, quit). */
  flush(): Promise<void> {
    return this.writing;
  }

  private async write(line: string): Promise<void> {
    await mkdir(dirname(this.o.file), { recursive: true });
    try {
      if ((await stat(this.o.file)).size > this.maxBytes) await rename(this.o.file, `${this.o.file}.1`);
    } catch {
      // no file yet
    }
    await appendFile(this.o.file, line, "utf8");
  }
}
