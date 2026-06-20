#!/usr/bin/env node
'use strict';

// claude-nomad docs-sync gate.
//
// Enforces that a change to the authoritative CLI usage surface is accompanied
// by a documentation update, so new flags/commands cannot ship undocumented.
//
// The canary is `src/nomad.help.ts` (the `DEFAULT_HELP` usage block): every new
// flag or command edits it. When the canary changes, at least one documentation
// surface (`README.md` or the docs-site command reference) must change too.
//
// Used two ways:
//   - CI: `.github/workflows/docs-check.yml` runs it against the PR base sha.
//     The `docs-not-needed` PR label bypasses the whole job at the workflow
//     level, so a genuinely doc-free change is not blocked.
//   - Local: a pre-PR hook runs it against `origin/main`. Set
//     `DOCS_CHECK_BYPASS=1` to skip when the change genuinely needs no docs.
//
// Exit codes:
//   0  no canary change, OR docs changed alongside it, OR bypassed.
//   1  canary changed with no documentation update (the enforced failure).
//   2  could not compute the diff (bad/missing base ref); surfaced, not silent.

const { execFileSync } = require('node:child_process');

/** The CLI usage surface whose change requires a docs update. */
const CANARY_FILES = ['src/nomad.help.ts'];

/** Documentation surfaces that satisfy the gate when the canary changes. */
const DOC_SURFACES = ['README.md', 'docs-site/src/content/docs/commands.md'];

/**
 * Pure decision: given the list of changed repo-relative paths, decide whether
 * the docs-sync gate passes. Passes unless a canary file changed and no doc
 * surface did.
 *
 * @param {string[]} changedFiles - repo-relative paths changed vs the base.
 * @returns {{ ok: boolean, canaryChanged: boolean, reason: string }}
 */
function evaluateDocsSync(changedFiles) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  const canaryChanged = files.some((f) => CANARY_FILES.includes(f));
  const docChanged = files.some((f) => DOC_SURFACES.includes(f));
  if (canaryChanged && !docChanged) {
    return {
      ok: false,
      canaryChanged,
      reason: 'CLI usage surface changed without a documentation update',
    };
  }
  return {
    ok: true,
    canaryChanged,
    reason: canaryChanged ? 'canary changed and docs updated' : 'no canary change',
  };
}

/**
 * Read the `--base <ref>` argument, defaulting to `origin/main`.
 *
 * @param {string[]} argv - process argv tail (e.g. `process.argv.slice(2)`).
 * @returns {string} the base ref to diff against.
 */
function parseBase(argv) {
  const i = argv.indexOf('--base');
  if (i !== -1 && typeof argv[i + 1] === 'string' && argv[i + 1].length > 0) {
    return argv[i + 1];
  }
  return 'origin/main';
}

/**
 * Return the repo-relative paths changed between `base` and `HEAD` (three-dot,
 * i.e. changes on this branch since it diverged from base). Throws if git
 * cannot resolve the range.
 *
 * @param {string} base - the base ref or sha.
 * @returns {string[]}
 */
function changedFilesSince(base) {
  const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * CLI entry: compute the diff, evaluate the gate, and exit with the documented
 * code. Honors the `DOCS_CHECK_BYPASS` env escape hatch.
 */
function main() {
  if (process.env.DOCS_CHECK_BYPASS === '1') {
    process.stdout.write('docs-sync: bypassed via DOCS_CHECK_BYPASS=1\n');
    return;
  }
  const base = parseBase(process.argv.slice(2));
  let changed;
  try {
    changed = changedFilesSince(base);
  } catch (err) {
    process.stderr.write(
      `docs-sync: could not diff against '${base}': ${err.message}\n` +
        'Ensure the base ref is fetched (CI uses fetch-depth: 0).\n',
    );
    process.exitCode = 2;
    return;
  }
  const verdict = evaluateDocsSync(changed);
  if (verdict.ok) {
    process.stdout.write(`docs-sync: OK (${verdict.reason})\n`);
    return;
  }
  process.stderr.write(
    'docs-sync check failed.\n\n' +
      `Changed the CLI usage surface (${CANARY_FILES.join(', ')}) without updating docs.\n` +
      'Update at least one of:\n' +
      DOC_SURFACES.map((d) => `  - ${d}`).join('\n') +
      '\n\nIf this change genuinely needs no docs, bypass with:\n' +
      "  - CI: add the 'docs-not-needed' label to the PR\n" +
      '  - local: DOCS_CHECK_BYPASS=1 <your command>\n',
  );
  process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = { evaluateDocsSync, parseBase, CANARY_FILES, DOC_SURFACES };
