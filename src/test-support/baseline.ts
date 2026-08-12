import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SHARED_BASELINE_KIND } from '../links.baseline.ts';

/**
 * Write a per-host shared-links baseline manifest into a fixture HOME, at the
 * path `sharedBaselinePath()` resolves to for `NOMAD_HOST=test-host`.
 *
 * Shared rather than re-declared per test file because its absence is load
 * bearing: `planSharedLinkDeletions` returns before it enumerates anything when
 * `readSharedBaseline()` yields `null`, so a fixture with no baseline never
 * reaches the enumeration at all. Any test asserting how many times one run
 * derives the shared-name list has to plant one, or it pins a count that only
 * holds on a host that has never completed a pull.
 *
 * @param testHome - The fixture HOME (what `process.env.HOME` is set to).
 * @param files - Baseline entries, keyed by `claudeHome()`-relative POSIX path.
 *   Omit it for a single entry, which is all a test needs to get past the trust
 *   gate. Resolved inside the body rather than as a parameter default so no two
 *   callers can ever share one object.
 */
export function plantSharedBaseline(
  testHome: string,
  files?: Record<string, { size: number; mtime: number; hash: string }>,
): void {
  const entries = files ?? { 'fixture.md': { size: 1, mtime: 1, hash: 'x' } };
  const cacheDir = join(testHome, '.cache', 'claude-nomad');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, 'shared-baseline-test-host.json'),
    JSON.stringify({
      schema: 1,
      scannerVersion: SHARED_BASELINE_KIND,
      configHash: 'not-applicable',
      files: entries,
    }) + '\n',
  );
}
