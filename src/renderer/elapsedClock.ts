// The recording timer (P2). Paused time does not count (R5), matching the audio files, where pauses are cut.
export class ElapsedClock {
  private startedAt = 0;
  private pausedAt: number | null = null;
  private pausedTotal = 0;
  private running = false;

  start(now: number): void {
    this.startedAt = now;
    this.pausedAt = null;
    this.pausedTotal = 0;
    this.running = true;
  }

  pause(now: number): void {
    if (this.running && this.pausedAt === null) this.pausedAt = now;
  }

  resume(now: number): void {
    if (this.pausedAt === null) return;
    this.pausedTotal += now - this.pausedAt;
    this.pausedAt = null;
  }

  /** Back to 00:00:00, not running. */
  reset(): void {
    this.running = false;
    this.pausedAt = null;
    this.pausedTotal = 0;
  }

  get isPaused(): boolean {
    return this.pausedAt !== null;
  }

  elapsed(now: number): number {
    if (!this.running) return 0;
    const end = this.pausedAt ?? now;
    return Math.max(0, end - this.startedAt - this.pausedTotal);
  }
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}
