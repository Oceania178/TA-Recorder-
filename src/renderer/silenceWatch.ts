// D-42: warn when one channel has been silent for too long while recording (e.g. the call plays on
// a device the app does not record). Paused time does not count: call reset() on resume.
export class SilenceWatch {
  private lastSound: number | null = null;

  constructor(private readonly opts: { limitMs: number; threshold: number }) {}

  /** Feed the current level; returns true while the warning should show. */
  update(now: number, level: number): boolean {
    if (this.lastSound === null || level >= this.opts.threshold) {
      this.lastSound = now;
      return false;
    }
    return now - this.lastSound >= this.opts.limitMs;
  }

  reset(now: number): void {
    this.lastSound = now;
  }
}
