// Wizard step 3 (D-132): both meters must move. Opens the mic (left) and Windows' system audio (right) the same
// way a recording does, but records nothing. "Play beep" plays a short tone on the default output; the system
// audio capture hears it, so the right meter moves without needing a call.
import { levelFromSamples } from "./levels";

export interface SoundCheck {
  levels(): [number, number];
  beep(): void;
  stop(): Promise<void>;
}

/** Needs a click (getDisplayMedia asks for a user gesture). Throws a plain-words Error when a device is blocked. */
export async function startSoundCheck(): Promise<SoundCheck> {
  let mic: MediaStream | null = null;
  let system: MediaStream | null = null;
  const stopAll = () => [mic, system].forEach((s) => s?.getTracks().forEach((t) => t.stop()));
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
  } catch {
    throw new Error("The microphone could not be opened. Do step 2 first.");
  }
  try {
    system = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    system.getVideoTracks().forEach((t) => {
      t.stop();
      system?.removeTrack(t);
    });
    if (system.getAudioTracks().length === 0) throw new Error("no audio");
  } catch {
    stopAll();
    throw new Error("System audio could not be captured.");
  }

  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.resume();
  const analysers = [ctx.createAnalyser(), ctx.createAnalyser()] as const;
  analysers.forEach((a) => (a.fftSize = 2048));
  ctx.createMediaStreamSource(mic).connect(analysers[0]);
  ctx.createMediaStreamSource(system).connect(analysers[1]);
  const buffers = [new Float32Array(2048), new Float32Array(2048)];

  return {
    levels: () => {
      const out = analysers.map((a, i) => {
        a.getFloatTimeDomainData(buffers[i]);
        return levelFromSamples(buffers[i]);
      });
      return [out[0], out[1]];
    },
    beep: () => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.6);
    },
    stop: async () => {
      stopAll();
      await ctx.close().catch(() => undefined);
    },
  };
}
