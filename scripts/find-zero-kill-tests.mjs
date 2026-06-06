// claude-nomad zero-kill test finder.
//
// Reads a Stryker mutation-report JSON and emits one line per test that killed
// zero mutants across the entire report. These are candidates for removal in a
// test-suite pruning pass; each should still be reviewed manually (a zero-kill
// test may document intent or guard a code path Stryker does not mutate).
//
// Inputs:
//   reports/mutation/mutation.json  (default, or pass an explicit path as argv[2])
//
// Output (stdout):
//   ZERO-KILL  <testFileName> > <test name>
//   (one line per zero-kill candidate; silent when every test kills at least one mutant)
//
// Exit codes:
//   0 on success (even when zero candidates found; absence of output means all
//     tests kill at least one mutant).
//   1 on unreadable report file, JSON parse error, or a report that is not an
//     object (a scalar or null body).
//
// ESM (.mjs) because package.json declares "type": "module".

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Derive the zero-kill test list from a Stryker mutation report.
 *
 * Builds the global set of test IDs that killed at least one mutant by
 * iterating `report.files[*].mutants[*].killedBy`. Any test ID in
 * `report.testFiles[*].tests` that is absent from that killer set is a
 * zero-kill candidate. All field accesses nullish-coalesce to empty so a
 * malformed or partial report never throws.
 *
 * @param {import('@stryker-mutator/api/reports').MutationTestResult} report
 *   Parsed mutation.json content.
 * @returns {{ file: string; id: string; name: string }[]}
 *   Array of zero-kill candidates with their source test file path, test ID,
 *   and human-readable test name.
 */
export function findZeroKillTests(report) {
  const r = report ?? {};
  const killers = new Set(
    Object.values(r.files ?? {}).flatMap((file) =>
      Object.values(file.mutants ?? {}).flatMap((m) => m.killedBy ?? []),
    ),
  );

  const candidates = [];
  for (const [fileName, testFile] of Object.entries(r.testFiles ?? {})) {
    for (const test of testFile.tests ?? []) {
      if (!killers.has(test.id)) {
        candidates.push({
          file: fileName,
          id: String(test.id ?? ''),
          name: String(test.name ?? ''),
        });
      }
    }
  }
  return candidates;
}

/**
 * True when this module is the process entry point (invoked directly), false
 * when imported by tests. Compares realpaths on both sides so invocation via a
 * symlink still matches: Node resolves `import.meta.url` through symlinks but
 * leaves `process.argv[1]` as the symlink path. Falls back to a plain inequality
 * when `argv[1]` is absent (e.g. a REPL import) so the guard never throws.
 *
 * @returns {boolean} Whether the script is running as the entry point.
 */
function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

// Run main only when invoked directly, not when imported by tests.
if (isDirectInvocation()) {
  const reportPath = process.argv[2] ?? 'reports/mutation/mutation.json';
  let raw;
  try {
    raw = readFileSync(reportPath, 'utf8');
  } catch (err) {
    process.stderr.write(`find-zero-kill-tests: cannot read ${reportPath}: ${String(err)}\n`);
    process.exit(1);
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `find-zero-kill-tests: JSON parse error in ${reportPath}: ${String(err)}\n`,
    );
    process.exit(1);
  }
  if (typeof report !== 'object' || report === null) {
    process.stderr.write(`find-zero-kill-tests: report is not an object in ${reportPath}\n`);
    process.exit(1);
  }
  const candidates = findZeroKillTests(report);
  for (const { file, name } of candidates) {
    console.log(`ZERO-KILL  ${file} > ${name}`);
  }
}
