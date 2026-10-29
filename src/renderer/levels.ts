// Meter level (P4): RMS of a block of samples on a -60 dBFS .. 0 dBFS scale, as 0..1.
const FLOOR_DB = -60;

export function levelFromSamples(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
}
