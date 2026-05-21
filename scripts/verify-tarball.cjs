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
//      CHANGELOG.md, package.json, shared/.gitignore, .gitleaks.toml, and
//      at least one src/*.ts file).
//   4. Assert no path matches the FORBIDDEN regex (.planning, .github,
//      tests, node_modules, scripts, hosts, install.sh, tsconfig.json,
//      vitest.config.ts). This is how the verifier confirms it has NOT
//      itself leaked into the tarball (scripts/ is forbidden).
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
  'shared/.gitignore',
  '.gitleaks.toml',
];

const REQUIRED_PATTERN = /^src\/.+\.ts$/;

const FORBIDDEN =
  /^(\.planning|\.github|tests|node_modules|scripts|hosts|install\.sh|tsconfig\.json|vitest\.config\.ts)(?:\/|$)/;

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

let reports;
try {
  reports = JSON.parse(raw);
} catch (err) {
  process.stderr.write(`verify-tarball: FAIL\n  could not parse npm pack JSON: ${err.message}\n`);
  process.exit(1);
}

if (!Array.isArray(reports) || reports.length === 0 || !Array.isArray(reports[0].files)) {
  process.stderr.write(
    'verify-tarball: FAIL\n  npm pack JSON shape unexpected (expected reports[0].files array)\n',
  );
  process.exit(1);
}

const paths = reports[0].files.map((f) => f.path);

const requiredMissing = REQUIRED_EXACT.filter((p) => !paths.includes(p));
if (!paths.some((p) => REQUIRED_PATTERN.test(p))) {
  requiredMissing.push('src/*.ts (no source TS files matched)');
}

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
