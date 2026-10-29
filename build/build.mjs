// Bundles main, preload and renderer with esbuild into dist/. Static renderer files (HTML/CSS) are copied.
import { build } from "esbuild";
import { cpSync, mkdirSync, existsSync } from "node:fs";

const common = { bundle: true, sourcemap: true, logLevel: "info" };
await build({ ...common, entryPoints: ["src/main/main.ts"], outfile: "dist/main/main.js", platform: "node", format: "cjs", external: ["electron"] });
for (const preload of ["preload", "decoderPreload"]) {
  if (existsSync(`src/main/${preload}.ts`)) {
    await build({ ...common, entryPoints: [`src/main/${preload}.ts`], outfile: `dist/main/${preload}.js`, platform: "node", format: "cjs", external: ["electron"] });
  }
}
for (const page of ["recorder", "bar", "decoder"]) {
  if (existsSync(`src/renderer/${page}.ts`)) {
    await build({ ...common, entryPoints: [`src/renderer/${page}.ts`], outfile: `dist/renderer/${page}.js`, platform: "browser", format: "iife" });
  }
}
mkdirSync("dist/renderer", { recursive: true });
if (existsSync("src/renderer/static")) cpSync("src/renderer/static", "dist/renderer", { recursive: true });
