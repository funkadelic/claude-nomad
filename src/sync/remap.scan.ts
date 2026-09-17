/**
 * Read-only accounting of session files that exist on this host but not in the
 * repo, split out of `remap.ts` so the counter stays clear of the copy paths.
 * Performs no filesystem mutation.
 */

import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { assertSafeLogical } from '../core/config.sharedDirs.guard.ts';
import { assertSafeLocalRoot } from './extras/guards.ts';
import { claudeHome, repoHome, HOST } from '../core/config.ts';
import { encodePath, readPathMap } from '../core/utils.json.ts';

/**
 * Recursively count leaf files under `dst` absent from `src`. A dst
 * subdirectory is always recursed into, so a wholly local-only `subagents/` or
 * `memory/` tree contributes each leaf. Uses `lstatSync` so a dst symlink
 * counts as one leaf and is never followed into an external tree.
 */
function countLocalOnly(src: string, dst: string): number {
  let count = 0;
  for (const name of readdirSync(dst)) {
    const dstPath = join(dst, name);
    const srcPath = join(src, name);
    if (lstatSync(dstPath).isDirectory()) {
      count += countLocalOnly(srcPath, dstPath);
    } else if (lstatSync(srcPath, { throwIfNoEntry: false }) === undefined) {
      // lstat (no symlink follow) so a broken repo-side symlink of the same
      // name still counts as present, not as a spurious local-only leaf.
      count++;
    }
  }
  return count;
}

// Walks the same iteration skeleton as `remapPull` in remap.ts: path-map read,
// assertSafeLogical per key, skip a missing or 'TBD' host path,
// assertSafeLocalRoot, encodePath dst resolution. The two loops live in separate
// files now, so keep their guards in step when either changes.

// Retain-merge never changes the local-only set, so the pre-copy and post-copy
// counts are equal. That is what lets the wet pull summary and the dry-run
// preview both call this against current state.

/**
 * Total local-only session leaf files across all mapped projects, the honest
 * count behind the wet pull summary and the offline preview. Retain-merge keeps
 * these entries, so the count reframes a misleading `clean` into "N local-only
 * present (push to reconcile)". Returns 0 when there is nothing mapped to walk.
 */
export function scanLocalOnly(): number {
  const repo = repoHome();
  const claude = claudeHome();
  const mapPath = join(repo, 'path-map.json');
  const repoProjects = join(repo, 'shared', 'projects');
  if (!existsSync(mapPath) || !existsSync(repoProjects)) return 0;

  const map = readPathMap(mapPath);
  const localProjects = join(claude, 'projects');
  let count = 0;
  for (const [logical, hosts] of Object.entries(map.projects)) {
    assertSafeLogical(logical);
    const localPath = hosts[HOST];
    if (!localPath || localPath === 'TBD') continue;
    assertSafeLocalRoot(localPath, logical);
    const dst = join(localProjects, encodePath(localPath));
    if (!existsSync(dst)) continue;
    count += countLocalOnly(join(repoProjects, logical), dst);
  }
  return count;
}
