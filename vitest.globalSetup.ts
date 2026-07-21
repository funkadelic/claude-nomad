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

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { build } from 'esbuild';
import type { TestProject } from 'vitest/node';

// Anchored to THIS file, not process.cwd(): esbuild resolves relative
// entryPoints/outfile against the cwd, while `runNomad` resolves the bundle
// against src/test-support/world.ts. Any vitest invocation whose cwd is not the
// repo root would write the bundle somewhere the spawner never looks.
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const OUT_DIR = join(ROOT, '.test-bundle');

/**
 * esbuild-bundle the CLI and its worker entry point into `.test-bundle/`.
 * Mirrors the options in scripts/build.mjs so the spawned artifact matches the
 * published one.
 */
async function buildBundles(): Promise<void> {
  await Promise.all([
    build({
      entryPoints: [join(ROOT, 'src', 'nomad.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: join(OUT_DIR, 'nomad.test.mjs'),
      banner: { js: '#!/usr/bin/env node' },
      logLevel: 'silent',
    }),
    build({
      entryPoints: [join(ROOT, 'src', 'spinner.worker.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: join(OUT_DIR, 'nomad.worker.mjs'),
      logLevel: 'silent',
    }),
  ]);
}

/**
 * Build the bundles once before any project's workers start, then rebuild on
 * every watch-mode rerun. Without the rerun hook a watching developer keeps
 * spawning the bundle built at startup, so edits to src/ appear to have no
 * effect on the integration suites.
 *
 * @param project - Vitest project handle, used to register the rerun hook.
 */
export default async function setup(project: TestProject): Promise<void> {
  await buildBundles();
  project.onTestsRerun(buildBundles);
}
