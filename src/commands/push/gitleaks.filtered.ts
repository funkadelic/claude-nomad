/**
 * Re-scans the real content behind clean-filtered staged files (git-lfs, say),
 * which the staged scan sees only as filter output.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import type { Finding, ScanFn } from './gitleaks.scan.ts';
import { repoExecOpts } from './gitleaks.stage.ts';

/**
 * Staged paths (deletions excluded) whose `filter` attribute is set to a driver.
 * Throws on any git failure so the caller can fail closed.
 */
function filteredPaths(repoDir: string): string[] {
  const opts = { ...repoExecOpts(repoDir), maxBuffer: 64 * 1024 * 1024 };
  // ls-files, not diff: a diff.* config error must not fail the listing, and staged deletions are already absent.
  const listing = execFileSync('git', ['ls-files', '--cached', '-z'], opts);
  // stdin must be a pipe: execFileSync drops `input` when stdio[0] is 'ignore'.
  const attrs = execFileSync('git', ['check-attr', '--stdin', '-z', 'filter'], {
    ...opts,
    stdio: ['pipe', 'pipe', 'pipe'],
    input: listing,
  }) as Buffer;
  const parts = attrs.toString('utf8').split('\0');
  const paths: string[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (parts[i + 2] !== 'unspecified' && parts[i + 2] !== 'unset') paths.push(parts[i]);
  }
  return paths;
}

/**
 * Re-scan every staged path with a clean filter from its working-tree file via
 * `scan` (which stages with the filter off) and merge the results into `staged`,
 * deduped by `Fingerprint`. Returns `null` when the listing or any per-file scan
 * fails, so the push gate fails closed.
 */
export function withFilteredFindings(
  repoDir: string,
  staged: Finding[],
  scan: ScanFn,
  forwardStreams: boolean,
): Finding[] | null {
  let paths: string[];
  try {
    paths = filteredPaths(repoDir);
  } catch (err) {
    if (forwardStreams) {
      process.stderr.write(`scan aborted: ${String((err as Error).message).split('\n')[0]}\n`);
    }
    return null;
  }
  const merged = [...staged];
  const seen = new Set(merged.map((f) => f.Fingerprint));
  for (const rel of paths) {
    const found = scan(join(repoDir, rel), {
      stagedRel: rel,
      redact: true,
      repoDir,
      forwardStreams,
    });
    if (found === null) return null;
    for (const f of found) {
      if (!seen.has(f.Fingerprint)) {
        seen.add(f.Fingerprint);
        merged.push(f);
      }
    }
  }
  return merged;
}
