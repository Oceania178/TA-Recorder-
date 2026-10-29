// electron-builder afterPack hook (package.json build.afterPack): sets Electron's fuses in the packaged
// TA Call Recorder.exe (APP review M11). electron-builder 25 has no `electronFuses` option, and the
// @electron/fuses package is not installed, so this flips the fuse wire directly. The format is Electron's:
// a fixed sentinel, then a version byte (1), a length byte, then one byte per fuse: "0" off, "1" on.
// Fuse order (version 1): 0 RunAsNode, 1 EnableCookieEncryption, 2 EnableNodeOptionsEnvironmentVariable,
// 3 EnableNodeCliInspectArguments, 4 EnableEmbeddedAsarIntegrityValidation, 5 OnlyLoadAppFromAsar,
// 6 LoadBrowserProcessSpecificV8Snapshot, 7 GrantFileProtocolExtraPrivileges.
// ASAR integrity (4) is left as it is: electron-builder 25 does not embed the Windows integrity resource,
// and turning the fuse on without it stops the app from starting.
const fs = require("node:fs");
const path = require("node:path");

const SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");

/** Index → wanted state. */
const WANTED_FUSES = { 0: "0", 1: "1", 2: "0", 3: "0", 5: "1" };

/** Flips the fuses in an exe image in place. Returns the wire before and after. */
function flipFuses(exe, want) {
  const at = exe.indexOf(SENTINEL);
  if (at < 0) throw new Error("No Electron fuse wire found in this file");
  const version = exe[at + SENTINEL.length];
  const length = exe[at + SENTINEL.length + 1];
  if (version !== 1) throw new Error(`Unknown fuse wire version ${version}`);
  const start = at + SENTINEL.length + 2;
  const before = exe.subarray(start, start + length).toString("latin1");
  for (const [index, state] of Object.entries(want)) {
    const i = Number(index);
    if (i >= length) throw new Error(`Fuse ${i} does not exist in this Electron`);
    exe[start + i] = state.charCodeAt(0);
  }
  return { before, after: exe.subarray(start, start + length).toString("latin1") };
}

async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const image = fs.readFileSync(exe);
  const r = flipFuses(image, WANTED_FUSES);
  fs.writeFileSync(exe, image);
  console.log(`  • fuses ${r.before} -> ${r.after}`);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.flipFuses = flipFuses;
module.exports.WANTED_FUSES = WANTED_FUSES;
