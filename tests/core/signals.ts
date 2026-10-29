// Synthetic test signals (no real audio in tests). Deterministic: a seeded generator, no Math.random.

export function seeded(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export type Piece =
  | { kind: "silence"; ms: number; noise?: number }
  | { kind: "tone"; ms: number; hz?: number; amp?: number; noise?: number }
  | { kind: "noise"; ms: number; amp?: number };

/** Concatenate pieces into one mono signal. `noise` is a background hiss amplitude (default 0.001 ≈ -60 dBFS). */
export function build(sampleRate: number, pieces: Piece[], seed = 7): Float32Array {
  const rnd = seeded(seed);
  const total = pieces.reduce((n, p) => n + Math.round((p.ms / 1000) * sampleRate), 0);
  const out = new Float32Array(total);
  let i = 0;
  for (const p of pieces) {
    const n = Math.round((p.ms / 1000) * sampleRate);
    for (let k = 0; k < n; k++, i++) {
      const hiss = ((p.kind === "noise" ? 0 : p.noise ?? 0.001)) * (rnd() * 2 - 1);
      if (p.kind === "silence") out[i] = hiss;
      else if (p.kind === "tone") out[i] = (p.amp ?? 0.3) * Math.sin((2 * Math.PI * (p.hz ?? 220) * k) / sampleRate) + hiss;
      else out[i] = (p.amp ?? 0.3) * (rnd() * 2 - 1);
    }
  }
  return out;
}
