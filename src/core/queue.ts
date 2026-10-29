// core/queue.ts — the transcription / sending queue on disk (spec §2 step 5, §8.3; D-21 → D-139, D-82,
// D-85, D-144, D-147).
//
// Stages:  recorded → transcribing → transcribed → sending → sent
//          failed (with a reason and the stage to go back to on retry)
//          local_only (no Solace session, D-82: transcribed on the laptop and never sent)
//
// - One JSON file in the app data folder, rewritten atomically (temp + rename) on every change, so a crash
//   or power cut never leaves half a queue. A damaged file is moved aside and the queue starts empty.
// - After a restart, work in progress goes back one step (transcribing → recorded, sending → transcribed)
//   and simply runs again: transcription resumes from its checkpoint (pipeline.ts), and a resend is the
//   same call for Solace (D-85).
// - One job at a time, oldest first. Retryable problems wait with growing backoff (and at least as long as
//   the server asked); there is no attempt cap for them because the real limits are the 72 h send window
//   (D-144) and the 3-day file life (D-140). An unexpected exception is retried a few times, then fails.
// - The queue file holds no ticket, no key and no transcript text: the upload ticket comes from secure
//   storage through `getUploadTicket(jobId)` at the moment of sending (D-147); the text lives in the
//   call's folder beside the audio.
import { readFile, rename } from "node:fs/promises";
import { writeFileAtomic } from "./atomicWrite";
import { backoffMs } from "./http";
import type { DialMode } from "./types";

export type Stage = "recorded" | "transcribing" | "transcribed" | "sending" | "sent" | "failed" | "local_only";

export type FailureReason =
  | "no_gemini_key" | "gemini_key_rejected" | "gemini_model_not_found" | "gemini_bad_request" | "audio_missing"
  | "no_solace_address" | "upload_ticket_missing" | "upload_window_closed" | "transcript_missing"
  | "solace_refused" | "solace_invalid" | "solace_different_content" | "transcript_too_large" | "app_bug"
  | "unexpected_error";

export interface Failure {
  reason: FailureReason;
  /** When it failed (ISO). */
  at: string;
  /** Where retry() puts the job back. */
  stage: "recorded" | "transcribed";
  /** Solace's 400 reasons (field paths and rules — never transcript text). */
  details?: string[];
}

export interface NewJob {
  /** The call id: the Solace session id, or a local id for a local-only call. Also the file name (D-84). */
  id: string;
  /** Null = local only, never sent (D-82). */
  sessionId: string | null;
  dialMode: DialMode | null;
  /** The call's own folder under the recordings folder. */
  folder: string;
  /** ISO 8601 with the zone, as they go into the payload. */
  startedAt: string;
  endedAt: string;
  /** The ticket check's `upload_until` (D-144); null for a local-only call. */
  sendBy: string | null;
}

export interface Job extends NewJob {
  stage: Stage;
  /** Retries at the current stage. */
  attempts: number;
  nextAttemptAt: string | null;
  callId: string | null;
  duplicate: boolean;
  failure: Failure | null;
  createdAt: string;
  updatedAt: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const FILE_VERSION = 1;
const TERMINAL: ReadonlySet<Stage> = new Set(["sent", "local_only", "failed"]);
const WAITING: ReadonlySet<Stage> = new Set(["recorded", "transcribed"]);

export class JobQueue {
  #jobs: Job[] = [];
  #writing: Promise<void> = Promise.resolve();
  /** True when the file was damaged and moved aside on open. */
  recoveredFromDamage = false;

  private constructor(private readonly file: string, private readonly now: () => number) {}

  static async open(file: string, o: { now?: () => number } = {}): Promise<JobQueue> {
    const q = new JobQueue(file, o.now ?? Date.now);
    let text: string | null = null;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (text !== null) {
      try {
        const data = JSON.parse(text) as { version?: number; jobs?: Job[] };
        if (data.version !== FILE_VERSION || !Array.isArray(data.jobs)) throw new Error("not a queue file");
        q.#jobs = data.jobs.filter((j) => j && typeof j.id === "string" && SAFE_ID.test(j.id));
      } catch {
        await rename(file, `${file}.damaged-${q.now()}`).catch(() => undefined);
        q.recoveredFromDamage = true;
        q.#jobs = [];
      }
    }
    let resumed = false;
    for (const j of q.#jobs) {
      if (j.stage === "transcribing") { j.stage = "recorded"; resumed = true; }
      if (j.stage === "sending") { j.stage = "transcribed"; resumed = true; }
    }
    if (resumed || q.recoveredFromDamage) await q.#save();
    return q;
  }

  list(): Job[] {
    return this.#jobs.map((j) => ({ ...j }));
  }

  get(id: string): Job | undefined {
    const j = this.#jobs.find((x) => x.id === id);
    return j ? { ...j } : undefined;
  }

  /** True while the job is being transcribed or sent: retention must not delete its folder then. */
  isBusy(id: string): boolean {
    const s = this.#jobs.find((x) => x.id === id)?.stage;
    return s === "transcribing" || s === "sending";
  }

  async add(n: NewJob): Promise<Job> {
    if (!SAFE_ID.test(n.id)) throw new Error("unsafe job id");
    if (this.#jobs.some((j) => j.id === n.id)) throw new Error("job already queued");
    const at = this.#iso();
    const job: Job = { ...n, stage: "recorded", attempts: 0, nextAttemptAt: null, callId: null, duplicate: false, failure: null, createdAt: at, updatedAt: at };
    this.#jobs.push(job);
    await this.#save();
    return { ...job };
  }

  /** Move to a stage. Entering an in-progress stage keeps the retry count; any other stage starts afresh. */
  async setStage(id: string, stage: Stage, extra: Partial<Pick<Job, "callId" | "duplicate">> = {}): Promise<void> {
    const inProgress = stage === "transcribing" || stage === "sending";
    await this.#patch(id, { stage, nextAttemptAt: null, failure: null, ...(inProgress ? {} : { attempts: 0 }), ...extra });
  }

  /** Wait before trying this job's current step again. */
  async defer(id: string, untilMs: number, stage: "recorded" | "transcribed"): Promise<void> {
    const j = this.#must(id);
    await this.#patch(id, { stage, attempts: j.attempts + 1, nextAttemptAt: new Date(untilMs).toISOString() });
  }

  async fail(id: string, reason: FailureReason, details?: string[]): Promise<void> {
    const j = this.#must(id);
    const back = j.stage === "transcribed" || j.stage === "sending" ? "transcribed" : "recorded";
    const failure: Failure = { reason, at: this.#iso(), stage: back, ...(details?.length ? { details } : {}) };
    await this.#patch(id, { stage: "failed", nextAttemptAt: null, failure });
  }

  /** Put a failed job back where it failed (e.g. after the TA set the Gemini key). */
  async retry(id: string): Promise<void> {
    const j = this.#must(id);
    if (j.stage !== "failed" || !j.failure) return;
    await this.#patch(id, { stage: j.failure.stage, attempts: 0, nextAttemptAt: null, failure: null });
  }

  /** Drop jobs whose folder retention deleted. `unsent` counts those that never reached Solace or ended local. */
  async forget(ids: readonly string[]): Promise<{ removed: number; unsent: number }> {
    const gone = new Set(ids);
    const removed = this.#jobs.filter((j) => gone.has(j.id));
    if (!removed.length) return { removed: 0, unsent: 0 };
    this.#jobs = this.#jobs.filter((j) => !gone.has(j.id));
    await this.#save();
    return { removed: removed.length, unsent: removed.filter((j) => j.stage !== "sent" && j.stage !== "local_only").length };
  }

  /** The oldest job whose next step is due now, if any. */
  nextDue(nowMs = this.now()): Job | undefined {
    const j = this.#jobs.find((x) => WAITING.has(x.stage) && (!x.nextAttemptAt || Date.parse(x.nextAttemptAt) <= nowMs));
    return j ? { ...j } : undefined;
  }

  /** When the next waiting job becomes due (ms), or null when nothing waits. */
  nextWakeAt(): number | null {
    const times = this.#jobs.filter((j) => WAITING.has(j.stage)).map((j) => (j.nextAttemptAt ? Date.parse(j.nextAttemptAt) : this.now()));
    return times.length ? Math.min(...times) : null;
  }

  isTerminal(id: string): boolean {
    const s = this.#jobs.find((x) => x.id === id)?.stage;
    return s !== undefined && TERMINAL.has(s);
  }

  #iso(): string {
    return new Date(this.now()).toISOString();
  }

  #must(id: string): Job {
    const j = this.#jobs.find((x) => x.id === id);
    if (!j) throw new Error("no such job");
    return j;
  }

  async #patch(id: string, p: Partial<Job>): Promise<void> {
    Object.assign(this.#must(id), p, { updatedAt: this.#iso() });
    await this.#save();
  }

  /** Writes one at a time, each with the state at that moment. */
  #save(): Promise<void> {
    const run = this.#writing.then(() => writeFileAtomic(this.file, `${JSON.stringify({ version: FILE_VERSION, jobs: this.#jobs }, null, 2)}\n`));
    this.#writing = run.catch(() => undefined);
    return run;
  }
}

/** What a step reports back to the runner. */
export type StepOutcome =
  | { ok: true }
  | { ok: false; retryable: true; retryAfterMs?: number | null }
  | { ok: false; retryable: false; reason: FailureReason; details?: string[] };

export type SendOutcome = { ok: true; callId: string; duplicate: boolean } | Exclude<StepOutcome, { ok: true }>;

export interface RunnerDeps {
  queue: JobQueue;
  /** recorded → transcribed: VAD, Gemini, transcript files (pipeline.ts transcribeJob). */
  transcribe(job: Job): Promise<StepOutcome>;
  /** transcribed → sent: read the .transcript.json and upload it (pipeline.ts sendJob). */
  send(job: Job, uploadTicket: string): Promise<SendOutcome>;
  /** From secure storage (Electron safeStorage); null when it is not there. */
  getUploadTicket(jobId: string): Promise<string | null>;
  /** Called once the ticket can never be used again (sent, or refused for good). */
  forgetUploadTicket?(jobId: string): Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Every time a job changes stage (for the UI). Never log the job's folder. */
  onChange?(job: Job): void;
}

const RETRY_BACKOFF = { baseMs: 30_000, maxMs: 30 * 60_000 };
const MAX_UNEXPECTED_ERRORS = 5;
/** After these the upload ticket is useless. */
const TICKET_IS_DONE: ReadonlySet<FailureReason> = new Set(["solace_refused", "solace_different_content", "upload_window_closed"]);

export class QueueRunner {
  #running: Promise<number> | null = null;
  private readonly now: () => number;

  constructor(private readonly d: RunnerDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Run every step that is due now, one job at a time. Concurrent calls share one run. */
  drain(): Promise<number> {
    if (!this.#running) {
      this.#running = (async () => {
        let steps = 0;
        try {
          while (await this.#step()) steps++;
        } finally {
          this.#running = null;
        }
        return steps;
      })();
    }
    return this.#running;
  }

  #changed(id: string): void {
    const j = this.d.queue.get(id);
    if (j && this.d.onChange) this.d.onChange(j);
  }

  async #step(): Promise<boolean> {
    const q = this.d.queue;
    const job = q.nextDue(this.now());
    if (!job) return false;
    const back = job.stage === "recorded" ? "recorded" : "transcribed";

    let outcome: StepOutcome | SendOutcome;
    try {
      if (job.stage === "recorded") {
        await q.setStage(job.id, "transcribing");
        this.#changed(job.id);
        outcome = await this.d.transcribe(job);
        if (outcome.ok) {
          await q.setStage(job.id, job.sessionId ? "transcribed" : "local_only");
          this.#changed(job.id);
          return true;
        }
      } else {
        if (!job.sessionId) {
          await q.setStage(job.id, "local_only");
          this.#changed(job.id);
          return true;
        }
        if (job.sendBy && Date.parse(job.sendBy) < this.now()) {
          outcome = { ok: false, retryable: false, reason: "upload_window_closed" };
        } else {
          const ticket = await this.d.getUploadTicket(job.id);
          if (!ticket) {
            outcome = { ok: false, retryable: false, reason: "upload_ticket_missing" };
          } else {
            await q.setStage(job.id, "sending");
            this.#changed(job.id);
            const sent = await this.d.send(job, ticket);
            if (sent.ok) {
              await q.setStage(job.id, "sent", { callId: sent.callId, duplicate: sent.duplicate });
              await this.d.forgetUploadTicket?.(job.id);
              this.#changed(job.id);
              return true;
            }
            outcome = sent;
          }
        }
      }
    } catch {
      // A bug or an I/O error inside a step: retry a few times, then stop with a reason.
      const current = q.get(job.id);
      if (!current) return true;
      if (current.attempts + 1 >= MAX_UNEXPECTED_ERRORS) {
        await q.fail(job.id, "unexpected_error");
      } else {
        await q.defer(job.id, this.now() + backoffMs(current.attempts, { ...RETRY_BACKOFF, random: this.d.random }), back);
      }
      this.#changed(job.id);
      return true;
    }

    if (outcome.ok) return true; // not reached: ok outcomes return above
    if (outcome.retryable) {
      const attempts = q.get(job.id)?.attempts ?? 0;
      const wait = Math.max(backoffMs(attempts, { ...RETRY_BACKOFF, random: this.d.random }), outcome.retryAfterMs ?? 0);
      await q.defer(job.id, this.now() + wait, back);
    } else {
      await q.fail(job.id, outcome.reason, outcome.details);
      if (TICKET_IS_DONE.has(outcome.reason)) await this.d.forgetUploadTicket?.(job.id);
    }
    this.#changed(job.id);
    return true;
  }
}
