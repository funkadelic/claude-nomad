// claude-nomad distribution build.
//
// Bundles src/nomad.ts and its imports into a single self-contained ESM file
// dist/nomad.mjs (plain JavaScript, no TypeScript syntax), prefixed with a
// node shebang. This is what the published `bin` points at.
//
// Why a bundle rather than shipping raw src/*.ts: Node refuses to type-strip
// TypeScript for files under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_
// STRIPPING), so a published src/nomad.ts bin crashes on every `npm i -g`
// invocation. Compiling to JS ahead of publish sidesteps that entirely and
// drops the runtime tsx dependency the previous shebang lazily network-installed.
//
// dist/nomad.mjs sits one directory below the package root, the same depth as
// src/, so the runtime `new URL('../.gitleaks.toml', import.meta.url)` lookup
// in resolveTomlPath still resolves the bundled allowlist at the package root.

import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

const outfile = 'dist/nomad.mjs';
const workerOutfile = 'dist/nomad.worker.mjs';

await Promise.all([
  build({
    entryPoints: ['src/nomad.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    banner: { js: '#!/usr/bin/env node' },
    logLevel: 'info',
  }),
  // Worker entry point: no shebang banner (it is a worker module, not a bin).
  build({
    entryPoints: ['src/spinner.worker.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: workerOutfile,
    logLevel: 'info',
  }),
]);

// npm sets the executable bit on bin entries at install time, but set it here
// too so a locally built dist/nomad.mjs is runnable without reinstalling.
chmodSync(outfile, 0o755);
