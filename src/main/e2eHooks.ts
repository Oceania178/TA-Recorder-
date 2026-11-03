// Development-only hooks for the end-to-end script (scripts/e2e). They exist so the whole flow can be proven on
// this laptop with fake servers and a fake sound source — no real Gemini, no real call, no real clock change.
//
// INERT in the installed app: readE2eHooks returns null whenever the app is packaged, and also in a development
// build unless it was started with BOTH --dev and --e2e (tests/app/e2eHooks.test.ts proves it).
//   --e2e-audio                       the recorder page plays scripted speech-like bursts into the same Web
//                                     Audio graph instead of opening the mic and the system loopback
//   --e2e-gemini-endpoint=http://127.0.0.1:<port>   Gemini requests go to a fake server on this laptop
//   --e2e-clock-offset-ms=<n>         the queue and the 3-day sweep see the clock n ms ahead (never Windows time)
//   --e2e-import-file=<absolute path> "Import a recording" (D-171) takes this file instead of opening the
//                                     Windows file picker
// Plain Node (no Electron import) so it can be tested.

export interface E2eHooks {
  fakeAudio: boolean;
  /** A loopback http origin, or null for the real Gemini address. */
  geminiEndpoint: string | null;
  clockOffsetMs: number;
  /** D-171: the file "Import a recording" uses instead of the file picker (an absolute path), or null. */
  importFile: string | null;
}

const MAX_OFFSET_MS = 30 * 86_400_000;
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;

function value(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const arg = argv.find((a) => typeof a === "string" && a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

export function readE2eHooks(argv: readonly string[], isPackaged: boolean): E2eHooks | null {
  if (isPackaged) return null;
  if (!argv.includes("--dev") || !argv.includes("--e2e")) return null;
  const endpoint = value(argv, "e2e-gemini-endpoint");
  const offsetText = value(argv, "e2e-clock-offset-ms");
  const importFile = value(argv, "e2e-import-file");
  const offset = offsetText !== null && /^\d+$/.test(offsetText) ? Number(offsetText) : 0;
  return {
    fakeAudio: argv.includes("--e2e-audio"),
    geminiEndpoint: endpoint !== null && LOOPBACK_ORIGIN.test(endpoint) ? endpoint : null,
    clockOffsetMs: offset <= MAX_OFFSET_MS ? offset : 0,
    importFile: importFile !== null && /^[a-z]:[\\/]/i.test(importFile) ? importFile : null,
  };
}
