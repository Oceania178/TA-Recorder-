// Audio capture, kept apart from the UI (D-125) so later steps reuse it.
//
// One AudioContext = one clock (R2, R3):
//   mic ──► mono ──┐
//                  ├─► ChannelMerger(2) ─► stereo destination ─► MediaRecorder  <id>.webm
//   loopback ► mono┘        │
//                           └─► ChannelSplitter ─► left  destination ─► MediaRecorder  <id>.left.webm
//                                              └─► right destination ─► MediaRecorder  <id>.right.webm
//                                              └─► one AnalyserNode per channel (meters, P4)
// Windows loopback sends nothing while no sound plays. The AudioContext still renders every 10 ms on its
// own clock and a MediaStreamAudioSourceNode with no data outputs zeros, so the right channel gets real-time
// silence instead of being squeezed (R3). Nothing is connected to the speakers.
import type { Track } from "../main/ipcTypes";
import { levelFromSamples } from "./levels";

export const MIME_TYPE = "audio/webm;codecs=opus";
export const BITS_PER_SECOND = 32000;
export const CHUNK_MS = 1000;

export interface CaptureOptions {
  /** P6: browser mic processing (echo cancellation, noise suppression, auto gain) on or off. */
  micProcessing: boolean;
  onChunk: (track: Track, data: Blob) => void;
  /** Something broke mid-call (device unplugged, recorder error). The caller should stop and save. */
  onFatal: (message: string) => void;
}

export interface CaptureSession {
  pause(): void;
  resume(): void;
  /** Stops all three recorders; resolves after their last chunk has been handed to onChunk. */
  stop(): Promise<void>;
  /** [left = you, right = other side], 0..1. */
  levels(): [number, number];
}

function monoNode(ctx: AudioContext): GainNode {
  const g = ctx.createGain();
  g.channelCount = 1;
  g.channelCountMode = "explicit";
  g.channelInterpretation = "speakers";
  return g;
}

function monoDestination(ctx: AudioContext): MediaStreamAudioDestinationNode {
  const d = ctx.createMediaStreamDestination();
  d.channelCount = 1;
  d.channelCountMode = "explicit";
  return d;
}

function stopAll(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

export async function startCapture(opts: CaptureOptions): Promise<CaptureSession> {
  if (!MediaRecorder.isTypeSupported(MIME_TYPE)) throw new Error("This computer cannot record Opus audio (audio/webm;codecs=opus).");

  let mic: MediaStream | null = null;
  let system: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  try {
    const p = opts.micProcessing;
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: p, noiseSuppression: p, autoGainControl: p, channelCount: 1 },
      video: false,
    });
  } catch {
    throw new Error("The microphone could not be opened. Check that a mic is plugged in and that Windows allows apps to use it.");
  }
  try {
    system = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    system.getVideoTracks().forEach((t) => {
      t.stop();
      system?.removeTrack(t);
    });
    if (system.getAudioTracks().length === 0) throw new Error("no audio track");
  } catch {
    stopAll(mic);
    stopAll(system);
    throw new Error("System audio (the other side of the call) could not be captured.");
  }

  try {
    ctx = new AudioContext({ sampleRate: 48000, latencyHint: "playback" });
    await ctx.resume();

    const micMono = monoNode(ctx);
    const sysMono = monoNode(ctx);
    ctx.createMediaStreamSource(mic).connect(micMono);
    ctx.createMediaStreamSource(system).connect(sysMono);

    const merger = ctx.createChannelMerger(2);
    micMono.connect(merger, 0, 0);
    sysMono.connect(merger, 0, 1);

    const stereoDest = ctx.createMediaStreamDestination();
    stereoDest.channelCount = 2;
    merger.connect(stereoDest);

    const splitter = ctx.createChannelSplitter(2);
    merger.connect(splitter);
    const leftDest = monoDestination(ctx);
    const rightDest = monoDestination(ctx);
    splitter.connect(leftDest, 0);
    splitter.connect(rightDest, 1);

    const analysers = [ctx.createAnalyser(), ctx.createAnalyser()] as const;
    analysers.forEach((a, ch) => {
      a.fftSize = 2048;
      splitter.connect(a, ch);
    });
    const buffers = [new Float32Array(2048), new Float32Array(2048)];

    let fatalSent = false;
    const fatal = (message: string) => {
      if (fatalSent) return;
      fatalSent = true;
      opts.onFatal(message);
    };
    mic.getAudioTracks().forEach((t) => t.addEventListener("ended", () => fatal("The microphone was disconnected. The recording so far has been saved.")));
    system.getAudioTracks().forEach((t) => t.addEventListener("ended", () => fatal("System audio capture stopped. The recording so far has been saved.")));

    const plan: [Track, MediaStream][] = [
      ["stereo", stereoDest.stream],
      ["left", leftDest.stream],
      ["right", rightDest.stream],
    ];
    const recorders = plan.map(([track, stream]) => {
      const rec = new MediaRecorder(stream, { mimeType: MIME_TYPE, audioBitsPerSecond: BITS_PER_SECOND });
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) opts.onChunk(track, e.data);
      };
      rec.onerror = () => fatal("The recorder stopped with an error. The recording so far has been saved.");
      return rec;
    });
    // Started back to back so the three files line up.
    recorders.forEach((r) => r.start(CHUNK_MS));

    const audioCtx = ctx;
    const micStream = mic;
    const sysStream = system;
    return {
      pause: () => recorders.forEach((r) => r.state === "recording" && r.pause()),
      resume: () => recorders.forEach((r) => r.state === "paused" && r.resume()),
      levels: () => {
        const out: number[] = analysers.map((a, i) => {
          a.getFloatTimeDomainData(buffers[i]);
          return levelFromSamples(buffers[i]);
        });
        return [out[0], out[1]];
      },
      stop: async () => {
        await Promise.all(
          recorders.map(
            (r) =>
              new Promise<void>((done) => {
                if (r.state === "inactive") return done();
                r.addEventListener("stop", () => done(), { once: true });
                r.stop();
              }),
          ),
        );
        stopAll(micStream);
        stopAll(sysStream);
        await audioCtx.close().catch(() => undefined);
      },
    };
  } catch (err) {
    stopAll(mic);
    stopAll(system);
    await ctx?.close().catch(() => undefined);
    throw err instanceof Error ? err : new Error("Recording could not start.");
  }
}

/** Device list for the R4 check. Labels are only filled in once the mic has been allowed. */
export async function listDevices(): Promise<{ deviceId: string; label: string; kind: string }[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.map((d) => ({ deviceId: d.deviceId, label: d.label, kind: d.kind }));
}
