// Any sample rate → 16 kHz, one block at a time (D-171 import, review R3 I2): imported files come at 8, 11.025,
// 22.05, 44.1 or 48 kHz, and the whole file must never be held decoded. A windowed-sinc low-pass (Blackman,
// cut-off at 90 % of 8 kHz) is applied at each output instant from a precomputed table of 512 fractional phases,
// so any ratio works and it stays fast; the state carries over between blocks, so the result does not depend on
// the block size, and the filter is centred (no time shift).
// Pure TypeScript: used by the hidden decoder page and by main (WAV files), tested in Node.

const HALF_OUT = 8; // filter half-width, in output samples
const PHASES = 512;

export class StreamResampler {
  private readonly step: number; // input samples per output sample
  private readonly half: number; // filter half-width, in input samples
  private readonly width: number; // taps per output sample
  private readonly table: Float32Array; // (PHASES + 1) rows of `width` normalised taps
  private buf = new Float32Array(0);
  private bufStart = 0; // global index of buf[0]
  private totalIn = 0;
  private nextOut = 0;

  constructor(readonly inRate: number, readonly outRate = 16000) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error("bad sample rate");
    this.step = inRate / outRate;
    this.half = Math.max(2, Math.ceil(HALF_OUT * Math.max(1, this.step)));
    this.width = 2 * this.half;
    const fc = (0.9 * (Math.min(inRate, outRate) / 2)) / inRate;
    this.table = new Float32Array((PHASES + 1) * this.width);
    for (let p = 0; p <= PHASES; p++) {
      const frac = p / PHASES;
      let norm = 0;
      const row = p * this.width;
      for (let j = 0; j < this.width; j++) {
        const x = j - this.half + 1 - frac; // tap at input index base - half + 1 + j, centre at base + frac
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const t = (x + this.half) / (2 * this.half);
        const w = t <= 0 || t >= 1 ? 0 : 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
        this.table[row + j] = sinc * w;
        norm += sinc * w;
      }
      for (let j = 0; j < this.width; j++) this.table[row + j] /= norm || 1;
    }
  }

  private produce(final: boolean): Float32Array {
    const total = final ? Math.round((this.totalIn * this.outRate) / this.inRate) : Infinity;
    const out: number[] = [];
    while (this.nextOut < total) {
      const centre = this.nextOut * this.step;
      const base = Math.floor(centre);
      // Without the future samples the filter needs, wait for the next block (unless this is the end).
      if (!final && base + this.half >= this.totalIn) break;
      const row = Math.round((centre - base) * PHASES) * this.width;
      const first = base - this.half + 1;
      let acc = 0;
      for (let j = 0; j < this.width; j++) {
        const n = first + j;
        if (n < 0 || n >= this.totalIn) continue;
        acc += this.buf[n - this.bufStart] * this.table[row + j];
      }
      out.push(acc);
      this.nextOut++;
    }
    // Keep only what the next output still needs.
    const keepFrom = Math.max(this.bufStart, Math.floor(this.nextOut * this.step) - this.half - 1);
    if (keepFrom > this.bufStart) {
      this.buf = this.buf.slice(keepFrom - this.bufStart);
      this.bufStart = keepFrom;
    }
    return Float32Array.from(out);
  }

  push(x: Float32Array): Float32Array {
    const next = new Float32Array(this.buf.length + x.length);
    next.set(this.buf);
    next.set(x, this.buf.length);
    this.buf = next;
    this.totalIn += x.length;
    return this.produce(false);
  }

  /** The last samples (the filter's tail), at the end of the stream. */
  flush(): Float32Array {
    return this.produce(true);
  }
}
