// R4 (best effort): which output device the app records, and a warning when Windows may send calls elsewhere.
// System audio is captured from Windows' default output device. Call apps such as 3CX often play on the
// "default communications device" instead; when that is a different device, the other side is not recorded.
export interface DeviceInfo {
  deviceId: string;
  label: string;
  kind: string;
}

export interface OutputCheck {
  outputs: string[];
  /** The device whose sound goes into the right channel. */
  recordedOutput: string | null;
  warnings: string[];
}

function stripPrefix(label: string, prefix: string): string {
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

export function checkOutputDevices(devices: DeviceInfo[]): OutputCheck {
  const outs = devices.filter((d) => d.kind === "audiooutput");
  if (outs.length === 0) return { outputs: [], recordedOutput: null, warnings: ["No output device found. Plug in your headset and press Check again."] };
  if (outs.every((d) => !d.label)) {
    return { outputs: [], recordedOutput: null, warnings: ["Device names are hidden until the app may use the microphone. Press Start once, or Check again."] };
  }
  const def = outs.find((d) => d.deviceId === "default");
  const comms = outs.find((d) => d.deviceId === "communications");
  const recordedOutput = def ? stripPrefix(def.label, "Default - ") : null;
  const commsName = comms ? stripPrefix(comms.label, "Communications - ") : null;
  const outputs = outs.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications").map((d) => d.label);

  const warnings: string[] = [];
  if (recordedOutput && commsName && commsName !== recordedOutput) {
    warnings.push(
      `Windows sends calls to "${commsName}" but the app records "${recordedOutput}". ` +
        `If 3CX plays on "${commsName}", the other side will not be recorded. ` +
        `Set 3CX's speaker to "${recordedOutput}", or make "${commsName}" the default device in Windows Sound settings.`,
    );
  }
  return { outputs, recordedOutput, warnings };
}
