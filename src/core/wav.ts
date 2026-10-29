// core/wav.ts — turn a slice of decoded PCM into a small WAV file for Gemini's inline upload (D-139: the
// audio goes to Gemini inline, never through the Files API, and never to Solace).
// Always 16 kHz, mono, 16-bit: plenty for a phone call and 32 KB per second (a 30 s segment ≈ 0.96 MB).

export const WAV_SAMPLE_RATE = 16_000;

/**
 * Change the sample rate. Downsampling averages the input samples each output sample covers (a simple
 * low-pass, enough for speech); upsampling interpolates linearly. Same rate → the same array.
 */
export function resample(pcm: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return pcm;
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError("sample rates must be positive");
  const ratio = fromRate / toRate;
  const n = Math.floor((pcm.length * toRate) / fromRate);
  const out = new Float32Array(n);
  if (ratio > 1) {
    for (let j = 0; j < n; j++) {
      const a = Math.floor(j * ratio);
      const b = Math.min(pcm.length, Math.max(a + 1, Math.floor((j + 1) * ratio)));
      let sum = 0;
      for (let i = a; i < b; i++) sum += pcm[i];
      out[j] = sum / (b - a);
    }
  } else {
    for (let j = 0; j < n; j++) {
      const x = j * ratio;
      const i = Math.floor(x);
      const frac = x - i;
      const s0 = pcm[Math.min(i, pcm.length - 1)];
      const s1 = pcm[Math.min(i + 1, pcm.length - 1)];
      out[j] = s0 + (s1 - s0) * frac;
    }
  }
  return out;
}

/** The samples between two times (milliseconds), clamped to the signal. A view, not a copy. */
export function slicePcm(pcm: Float32Array, sampleRate: number, startMs: number, endMs: number): Float32Array {
  const a = Math.max(0, Math.min(pcm.length, Math.round((startMs / 1000) * sampleRate)));
  const b = Math.max(a, Math.min(pcm.length, Math.round((endMs / 1000) * sampleRate)));
  return pcm.subarray(a, b);
}

/** A complete 16 kHz mono 16-bit PCM WAV file (44-byte header + samples). */
export function encodeWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const samples = resample(pcm, sampleRate, WAV_SAMPLE_RATE);
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, WAV_SAMPLE_RATE, true);
  v.setUint32(28, WAV_SAMPLE_RATE * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] || 0));
    v.setInt16(44 + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return out;
}
