// Step 2 wiring: what happens to a call after Stop (spec §2 steps 5–7, §8.3; D-82, D-139 to D-147).
//
//   Stop ─► add(call) ─► JobQueue (userData\queue.json) ─► QueueRunner, one job at a time:
//     recorded ─► transcribing (decode → VAD → Gemini → .transcript.md/.json) ─► transcribed
//     transcribed ─► sending (pinned Solace address + upload ticket from the secret store) ─► sent
//     a call without a Solace session ends as local_only: transcribed, never sent (D-82).
//
// - Drains after each Stop, at start-up, and at the queue's next wake time (a timer).
// - No Gemini key: the job waits in "recorded" (not failed) and the window says "Add a Gemini key in Settings
//   to transcribe"; adding a key resumes it at once (keyChanged).
// - The upload ticket is forgotten once the call is sent (or refused for good, or its window closed).
// - Retention (D-140): sweep() deletes call folders 3 days old, then forgets their jobs and tickets. Jobs
//   whose folder vanished while the app was closed (the logon cleanup task) are forgotten at start-up.
// Pure Node: the network (fetch), the decoder (loadPcm), the secrets and the timers are passed in.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  JobQueue, QueueRunner, formatIsoWithOffset, sendJob, transcribeJob,
  type DecodedCall, type FetchLike, type Job, type PcmSource, type StepOutcome,
} from "../core";
import { sweepRoots } from "./inProgressSweep";
import type { LinkedSession } from "./deepLinkFlow";

export interface SavedCall {
  /** The call id: the Solace session id for a linked call, a local id otherwise. */
  id: string;
  folder: string;
  startedAtMs: number;
  endedAtMs: number;
  session: LinkedSession | null;
}

export interface CallJobsDeps {
  queueFile: string;
  secrets: {
    getGeminiKey(): Promise<string | null>;
    getTicket(id: string): Promise<string | null>;
    /** The held ticket's details: its origin is where the transcript goes (APP review M2). */
    heldTicket(id: string): Promise<{ origin: string } | null>;
    forgetTicket(id: string): Promise<void>;
  };
  getBaseUrl(): string | null;
  getModel(): string;
  fetch: FetchLike;
  /** Decode the call's left and right files to 16 kHz PCM and open them as readers (APP review I3). */
  openPcm?(job: Job): Promise<PcmSource | null>;
  /** The older in-memory form (tests, short calls); used when openPcm is absent. */
  loadPcm?(job: Job): Promise<DecodedCall | null>;
  /** After the transcript is written: delete the temp PCM files. */
  afterTranscript?(job: Job): Promise<void>;
  appVersion: string;
  /** --dev build: http://localhost allowed as the Solace address. */
  dev?: boolean;
  now?: () => number;
  random?: () => number;
  geminiSleep?(ms: number): Promise<void>;
  geminiMaxAttempts?: number;
  /** Development-only e2e hook (e2eHooks.ts): a fake Gemini on this laptop. Never set in the installed app. */
  geminiEndpoint?: string;
  /** Minutes east of UTC at a moment (default: this laptop's zone). */
  tzOffsetMinutes?(ms: number): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  log?(event: string, fields: Record<string, unknown>): void;
  /** A job changed stage (refresh the Recent calls list). */
  onChange?(): void;
}

/** Without a key, look again this often (adding a key resumes at once anyway). */
const NO_KEY_RECHECK_MS = 6 * 3600_000;
/** Never spin: the next drain is at least this far away. */
const MIN_TIMER_MS = 1000;
/** setTimeout's limit (~24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

export class CallJobs {
  private timer: unknown = null;
  private noKey = false;
  private running: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly now: () => number;

  private constructor(private readonly d: CallJobsDeps, private readonly queue: JobQueue, private readonly runner: QueueRunner) {
    this.now = d.now ?? Date.now;
  }

  static async open(d: CallJobsDeps): Promise<CallJobs> {
    await mkdir(dirname(d.queueFile), { recursive: true });
    const queue = await JobQueue.open(d.queueFile, { now: d.now });
    let self: CallJobs | null = null;
    const runner = new QueueRunner({
      queue,
      now: d.now,
      random: d.random,
      transcribe: (job) => self!.transcribe(job),
      send: async (job, ticket) => {
        // The transcript goes to the origin the ticket was checked at (M2), never to a later setting.
        const origin = (await d.secrets.heldTicket(job.id))?.origin ?? null;
        return sendJob({ solace: { fetch: d.fetch, dev: d.dev, now: d.now }, getBaseUrl: () => origin }, job, ticket);
      },
      getUploadTicket: (id) => d.secrets.getTicket(id),
      forgetUploadTicket: (id) => d.secrets.forgetTicket(id),
      onChange: (job) => {
        d.log?.("job.stage", { id: job.id, stage: job.stage, reason: job.failure?.reason ?? null });
        d.onChange?.();
      },
    });
    self = new CallJobs(d, queue, runner);
    if (queue.recoveredFromDamage) d.log?.("queue.damaged", {});
    await self.forgetMissingFolders();
    return self;
  }

  private async transcribe(job: Job): Promise<StepOutcome> {
    const key = await this.d.secrets.getGeminiKey();
    if (!key) {
      // Wait in "recorded" until a key is added (keyChanged), instead of failing.
      this.noKey = true;
      return { ok: false, retryable: true, retryAfterMs: NO_KEY_RECHECK_MS };
    }
    this.noKey = false;
    const outcome = await transcribeJob({
      openPcm: this.d.openPcm ? (j) => this.d.openPcm!(j) : undefined,
      loadPcm: this.d.loadPcm ? (j) => this.d.loadPcm!(j) : undefined,
      getGeminiKey: async () => key,
      getModel: () => this.d.getModel(),
      gemini: { fetch: this.d.fetch, sleep: this.d.geminiSleep, random: this.d.random, now: this.d.now, maxAttempts: this.d.geminiMaxAttempts, endpoint: this.d.geminiEndpoint },
      appVersion: this.d.appVersion,
    }, job);
    if (outcome.ok) await this.d.afterTranscript?.(job).catch(() => undefined);
    return outcome;
  }

  private iso(ms: number): string {
    const offset = this.d.tzOffsetMinutes ? this.d.tzOffsetMinutes(ms) : -new Date(ms).getTimezoneOffset();
    return formatIsoWithOffset(ms, offset);
  }

  /** Stop pressed (or a crash recovered): queue the call and start working on it. */
  async add(call: SavedCall): Promise<void> {
    await this.enqueue(call);
    await this.drain();
  }

  /** Queue the call without waiting for the work (main: Stop must answer the window at once). */
  async enqueue(call: SavedCall): Promise<void> {
    if (!this.queue.get(call.id)) {
      await this.queue.add({
        id: call.id,
        sessionId: call.session?.sessionId ?? null,
        dialMode: call.session?.dialMode ?? null,
        folder: call.folder,
        startedAt: this.iso(call.startedAtMs),
        endedAt: this.iso(Math.max(call.endedAtMs, call.startedAtMs)),
        sendBy: call.session?.sendBy ?? null,
      });
      this.d.log?.("job.added", { id: call.id, linked: call.session !== null });
      this.d.onChange?.();
    }
  }

  /** Run everything that is due now, then set the timer for the next wake time. */
  drain(): Promise<void> {
    const run = this.running.then(async () => {
      if (this.closed) return;
      try {
        await this.runner.drain();
      } catch {
        this.d.log?.("queue.error", {});
      }
      this.schedule();
    });
    this.running = run.catch(() => undefined);
    return run;
  }

  /** Resolves when the current drain (if any) has finished. */
  idle(): Promise<void> {
    return this.running;
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    if (this.d.clearTimer) this.d.clearTimer(this.timer);
    else clearTimeout(this.timer as NodeJS.Timeout);
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = null;
    if (this.closed) return;
    const wake = this.queue.nextWakeAt();
    if (wake === null) return;
    const ms = Math.min(MAX_TIMER_MS, Math.max(MIN_TIMER_MS, wake - this.now()));
    const fire = () => {
      this.timer = null;
      void this.drain();
    };
    this.timer = this.d.setTimer ? this.d.setTimer(fire, ms) : setTimeout(fire, ms);
  }

  /** The Gemini key was added or changed: calls waiting for one start now. */
  async keyChanged(): Promise<void> {
    await this.idle();
    const key = await this.d.secrets.getGeminiKey();
    this.noKey = !key;
    if (!key) return;
    for (const j of this.queue.list()) {
      if (j.stage === "recorded" && j.nextAttemptAt) await this.queue.setStage(j.id, "recorded");
      if (j.stage === "failed" && j.failure?.reason === "no_gemini_key") await this.queue.retry(j.id);
    }
    this.d.onChange?.();
    await this.drain();
  }

  /** The TA pressed Retry on a failed call. */
  async retry(id: string): Promise<boolean> {
    const j = this.queue.get(id);
    if (!j || j.stage !== "failed") return false;
    await this.queue.retry(id);
    this.d.log?.("job.retry", { id });
    this.d.onChange?.();
    await this.drain();
    return true;
  }

  list(): Job[] {
    return this.queue.list();
  }

  get(id: string): Job | undefined {
    return this.queue.get(id);
  }

  /** True when a call is waiting to be transcribed and there is no Gemini key. */
  waitingForKey(): boolean {
    return this.noKey && this.queue.list().some((j) => j.stage === "recorded");
  }

  /**
   * D-140: delete call folders older than 3 days in every recordings folder used so far (I2a), and stuck
   * .in-progress leftovers (I2b) except the call being recorded; then forget their jobs and tickets.
   */
  async sweep(roots: string | readonly string[], activeId: string | null = null): Promise<{ deleted: number; kept: number; busy: number; errors: number }> {
    const list = typeof roots === "string" ? [roots] : roots;
    const r = await sweepRoots({ roots: list, nowMs: this.now(), isBusy: (id) => this.queue.isBusy(id), skipId: activeId });
    const forgotten = await this.queue.forget(r.deletedIds);
    for (const id of r.deletedIds) await this.d.secrets.forgetTicket(id).catch(() => undefined);
    this.d.log?.("retention.sweep", { deleted: r.deleted, kept: r.kept, busy: r.busy, not_ours: r.notOurs, errors: r.errors, unsent: forgotten.unsent });
    if (r.deleted) this.d.onChange?.();
    return { deleted: r.deleted, kept: r.kept, busy: r.busy, errors: r.errors };
  }

  /**
   * Jobs whose folder is gone (deleted by the logon cleanup task, or by hand) are dropped — but only when
   * the recordings folder itself is there: an unplugged or not-yet-mounted drive keeps its jobs and tickets
   * until it is back (APP review M9).
   */
  async forgetMissingFolders(): Promise<number> {
    const gone = this.queue.list().filter((j) => !existsSync(j.folder) && existsSync(dirname(j.folder))).map((j) => j.id);
    if (!gone.length) return 0;
    await this.queue.forget(gone);
    for (const id of gone) await this.d.secrets.forgetTicket(id).catch(() => undefined);
    this.d.log?.("queue.forgot_missing", { count: gone.length });
    return gone.length;
  }

  close(): void {
    this.closed = true;
    this.clearTimer();
    this.timer = null;
  }
}
