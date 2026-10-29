// 48 kHz → 16 kHz for transcription, one chunk at a time, so a whole call is never held at 48 kHz.
// A low-pass filter (windowed sinc, Blackman) keeps speech up to ~7 kHz and removes what 16 kHz cannot hold,
// then every 3rd sample is kept. The filter is centred, so the audio is not shifted in time, and its state
// carries over between chunks, so the result is the same whatever the chunk size.
// Pure TypeScript: used by the hidden decoder page, tested in Node.

export class Downsampler {
  private readonly factor: number;
  private readonly taps: Float32Array;
  private readonly half: number;
  /** Input samples from global index `bufStart` onward (older ones are no longer needed). */
  private buf = new Float32Array(0);
  private bufStart = 0;
  private totalIn = 0;
  private nextOut = 0;

  constructor(readonly inRate: number, readonly outRate = 16000) {
    if (!(inRate > 0) || !(outRate > 0) || inRate % outRate !== 0) throw new Error(`Cannot downsample ${inRate} Hz to ${outRate} Hz`);
    this.factor = inRate / outRate;
    this.half = 12 * this.factor;
    const n = 2 * this.half + 1;
    const fc = (0.9 * (outRate / 2)) / inRate; // cut-off as a fraction of the input rate
    const taps = new Float32Array(n);
    let sum = 0;
    for (let t = 0; t < n; t++) {
      const x = t - this.half;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * t) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * t) / (n - 1));
      taps[t] = sinc * w;
      sum += taps[t];
    }
    for (let t = 0; t < n; t++) taps[t] /= sum; // DC gain 1
    this.taps = taps;
  }

  private sample(g: number): number {
    return g < 0 || g >= this.totalIn ? 0 : this.buf[g - this.bufStart];
  }

  private output(j: number): number {
    const centre = j * this.factor;
    let acc = 0;
    for (let t = 0; t < this.taps.length; t++) acc += this.taps[t] * this.sample(centre + this.half - t);
    return acc;
  }

  push(input: Float32Array): Float32Array {
    const joined = new Float32Array(this.buf.length + input.length);
    joined.set(this.buf, 0);
    joined.set(input, this.buf.length);
    this.buf = joined;
    this.totalIn += input.length;

    const out: number[] = [];
    while (this.nextOut * this.factor + this.half < this.totalIn) out.push(this.output(this.nextOut++));

    const keepFrom = this.nextOut * this.factor - this.half;
    if (keepFrom > this.bufStart) {
      this.buf = this.buf.slice(Math.min(this.buf.length, keepFrom - this.bufStart));
      this.bufStart = keepFrom;
    }
    return Float32Array.from(out);
  }

  /** The last few samples (the end of the call is padded with silence). */
  flush(): Float32Array {
    const out: number[] = [];
    while (this.nextOut * this.factor < this.totalIn) out.push(this.output(this.nextOut++));
    return Float32Array.from(out);
  }
}
