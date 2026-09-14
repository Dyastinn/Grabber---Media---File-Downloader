// Bundles each browser-context entry point into a single self-contained
// (format: "iife") file in dist/. "iife" means the browser needs no
// understanding of ES modules at runtime — esbuild inlines every import
// itself — so manifest.json doesn't need "type": "module" anywhere, which
// keeps the background-script cross-browser trick (service_worker vs.
// scripts key) simple.
import { build, context } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const watch = process.argv.includes("--watch");

// ffmpeg.wasm's core, wasm and worker files must be served from inside the
// extension: Manifest V3 forbids loading executable code from a remote origin
// (so no CDN), and the extension CSP blocks the blob: worker @ffmpeg/ffmpeg
// creates by default. src/offscreen/ffmpeg-runner.ts loads these three from
// chrome-extension:// URLs.
//
// They must be the ESM builds. @ffmpeg/ffmpeg always spawns its worker with
// {type: "module"}, where importScripts() throws, so the worker falls back to
// a dynamic import(coreURL) — and in the UMD worker chunk (814.ffmpeg.js)
// webpack replaced that import() with a stub that only ever rejects with
// "Cannot find module". The ESM worker keeps the real import(), which works
// for a chrome-extension:// URL, and the ESM core is what it then imports.
const FFMPEG_ASSETS = [
  ["node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js", "dist/ffmpeg/ffmpeg-core.js"],
  ["node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm", "dist/ffmpeg/ffmpeg-core.wasm"],
];

// The ESM worker imports sibling modules (const.js, errors.js), so it is
// bundled rather than copied. format: "esm" keeps its dynamic import(coreURL)
// as a real import, which is the whole point (see above).
const FFMPEG_WORKER_BUILD = {
  entryPoints: ["node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js"],
  outfile: "dist/ffmpeg/worker.js",
  format: "esm",
};

function copyFfmpegAssets() {
  for (const [from, to] of FFMPEG_ASSETS) {
    if (!fs.existsSync(from)) {
      throw new Error(`Missing ffmpeg asset ${from} — run "npm install" first.`);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  console.log(`copied ${FFMPEG_ASSETS.length} ffmpeg assets to dist/ffmpeg/`);
}

/** @type {import('esbuild').BuildOptions} */
const sharedOptions = {
  bundle: true,
  format: "iife",
  target: "es2020",
  sourcemap: true,
  logLevel: "info",
};

const entryPoints = {
  "dist/background": "src/background/index.ts",
  "dist/content-script": "src/content/index.ts",
  "dist/popup": "src/popup/index.ts",
  "dist/offscreen": "src/offscreen/index.ts",
};

async function run() {
  copyFfmpegAssets();

  const builds = Object.entries(entryPoints).map(([outfile, entry]) => ({
    ...sharedOptions,
    entryPoints: [entry],
    outfile: `${outfile}.js`,
  }));
  builds.push({ ...sharedOptions, ...FFMPEG_WORKER_BUILD });

  if (watch) {
    const contexts = await Promise.all(builds.map((options) => context(options)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("esbuild watching for changes...");
  } else {
    await Promise.all(builds.map((options) => build(options)));
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
