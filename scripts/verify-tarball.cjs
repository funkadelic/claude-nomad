#!/usr/bin/env node
'use strict';

// claude-nomad publish-tarball whitelist verifier.
//
// Invoked from the `prepublishOnly` script. Exits non-zero on tarball
// composition drift so a misconfigured `files` field cannot ship the wrong
// content to the public npm registry.
//
// Steps:
//   1. Shell out to `npm pack --dry-run --json` from REPO_ROOT.
//   2. Parse the JSON. `npm pack --dry-run --json` returns an array of
//      tarball reports (one entry per package); we read reports[0].files.
//   3. Assert every REQUIRED path is present (LICENSE, README.md,
//      CHANGELOG.md, package.json, .gitleaks.toml, and the compiled bin
//      dist/nomad.mjs).
//   4. Assert no path matches the FORBIDDEN regex (.planning, .github,
//      tests, node_modules, scripts, hosts, install.sh, tsconfig.json,
//      vitest.config.ts, src, docs-site). This is how the verifier confirms it has NOT
//      itself leaked into the tarball (scripts/ is forbidden) and, critically,
//      that raw TypeScript under src/ is never shipped: Node refuses to
//      type-strip files under node_modules, so a published src/*.ts bin
//      crashes on global install.
//
// Exit codes:
//   0 on a healthy whitelist.
//   1 on any required-missing OR forbidden-present hit; the failure message
//     names both lists so the operator can fix the package.json `files`
//     field without running `npm pack` by hand.
//
// CommonJS (.cjs) is mandatory because package.json declares
// "type": "module". The script needs `require()` for node:child_process
// under the simplest possible invocation contract.

const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');

const REPO_ROOT = resolve(__dirname, '..');

const REQUIRED_EXACT = [
  'LICENSE',
  'README.md',
  'CHANGELOG.md',
  'package.json',
  '.gitleaks.toml',
  'dist/nomad.mjs',
  'dist/nomad.worker.mjs',
];

const FORBIDDEN =
  /^(\.planning|\.github|tests|node_modules|scripts|hosts|install\.sh|tsconfig\.json|vitest\.config\.ts|src|docs-site)(?:\/|$)/;

let raw;
try {
  raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
} catch (err) {
  process.stderr.write(`verify-tarball: FAIL\n  npm pack failed: ${err.message}\n`);
  process.exit(1);
}

// npm can prepend notice lines to stdout on some publish paths, so a raw
// JSON.parse is fragile. Salvage the JSON array between the first '[' and the
// last ']' when a direct parse fails.
function parseNpmPackJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // The --json array begins at the start of its own line, so anchor on that
    // (rather than the first '[') to skip any prepended notice line that itself
    // contains brackets.
    const startMatch = text.match(/^\s*\[/m);
    const end = text.lastIndexOf(']');
    if (startMatch && end > startMatch.index) {
      return JSON.parse(text.slice(startMatch.index, end + 1));
    }
    throw new Error('no JSON array found in npm pack output');
  }
}

let reports;
try {
  reports = parseNpmPackJson(raw);
} catch (err) {
  process.stderr.write(`verify-tarball: FAIL\n  could not parse npm pack JSON: ${err.message}\n`);
  process.exit(1);
}

if (
  !Array.isArray(reports) ||
  reports.length === 0 ||
  !reports[0] ||
  !Array.isArray(reports[0].files)
) {
  process.stderr.write(
    'verify-tarball: FAIL\n  npm pack JSON shape unexpected (expected reports[0].files array)\n',
  );
  process.exit(1);
}

const paths = reports[0].files.filter((f) => f && typeof f.path === 'string').map((f) => f.path);

const requiredMissing = REQUIRED_EXACT.filter((p) => !paths.includes(p));

const forbiddenPresent = paths.filter((p) => FORBIDDEN.test(p));

if (requiredMissing.length > 0 || forbiddenPresent.length > 0) {
  process.stderr.write('verify-tarball: FAIL\n');
  if (requiredMissing.length > 0) {
    process.stderr.write(`  required-missing: ${JSON.stringify(requiredMissing)}\n`);
  }
  if (forbiddenPresent.length > 0) {
    process.stderr.write(`  forbidden-present: ${JSON.stringify(forbiddenPresent)}\n`);
  }
  process.exit(1);
}

process.stdout.write(`verify-tarball: OK (${paths.length} files)\n`);
process.exit(0);
