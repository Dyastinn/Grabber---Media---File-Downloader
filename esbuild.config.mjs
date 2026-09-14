// Bundles each browser-context entry point into a single self-contained
// (format: "iife") file in dist/. "iife" means the browser needs no
// understanding of ES modules at runtime — esbuild inlines every import
// itself — so manifest.json doesn't need "type": "module" anywhere, which
// keeps the background-script cross-browser trick (service_worker vs.
// scripts key) simple.
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

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
};

async function run() {
  const builds = Object.entries(entryPoints).map(([outfile, entry]) => ({
    ...sharedOptions,
    entryPoints: [entry],
    outfile: `${outfile}.js`,
  }));

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
