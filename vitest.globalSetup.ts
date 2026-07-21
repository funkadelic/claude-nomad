// Precompile the CLI once per vitest run.
//
// The integration suites drive nomad as a real subprocess (see `runNomad` in
// src/test-support/world.ts). Spawning `node src/nomad.ts` made every one of
// those spawns re-type-strip the whole `nomad.ts` import graph, seconds of CPU
// per child, which is what pushed contended runs into the subprocess project's
// timeout ceiling. Bundling once up front turns each spawn back into a plain
// ~100ms Node boot.
//
// The bundle also makes the integration tests exercise something much closer to
// the published artifact: `dist/nomad.mjs` is a compiled bundle, and the
// raw-TS-under-node vs compiled distinction is exactly what broke 0.33.0 and
// 0.34.0. Options below therefore mirror scripts/build.mjs.
//
// Output lives at `.test-bundle/` (gitignored). The directory sits one level
// below the repo root, the same depth as `dist/` and `src/`, so the two
// runtime `new URL('../...', import.meta.url)` lookups inside the bundle
// (`resolveTomlPath` reaching for the package-bundled `.gitleaks.toml`) still
// resolve exactly as they do from the shipped location. The worker entry is
// emitted alongside it under the same `nomad.worker.mjs` name `resolveWorkerPath`
// expects of a compiled bundle sibling.

import { build } from 'esbuild';

const OUT_DIR = '.test-bundle';

/**
 * esbuild-bundle the CLI and its worker entry point into `.test-bundle/`.
 * Runs once per vitest run, before any project's workers start.
 */
export default async function setup(): Promise<void> {
  await Promise.all([
    build({
      entryPoints: ['src/nomad.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: `${OUT_DIR}/nomad.test.mjs`,
      banner: { js: '#!/usr/bin/env node' },
      logLevel: 'silent',
    }),
    build({
      entryPoints: ['src/spinner.worker.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: `${OUT_DIR}/nomad.worker.mjs`,
      logLevel: 'silent',
    }),
  ]);
}
