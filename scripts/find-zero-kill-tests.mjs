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
//   1 on JSON parse error or unreadable report file.
//
// ESM (.mjs) because package.json declares "type": "module".

import { readFileSync } from 'node:fs';

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

// Run main only when invoked directly, not when imported by tests.
if (import.meta.url === new URL(process.argv[1], 'file://').href) {
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
  const candidates = findZeroKillTests(report);
  for (const { file, name } of candidates) {
    console.log(`ZERO-KILL  ${file} > ${name}`);
  }
}
