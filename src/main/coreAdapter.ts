// The one place where the Electron side reaches into core (src/core, pure TypeScript, built by APP-B).
// Keeping it here means main code does not care where a helper lives, and APP-C can rewire it in one file.

/** True when a path is inside a OneDrive-synced folder (T20: recordings must never sync to the cloud). */
export { isUnderOneDrive } from "../core/settings";
