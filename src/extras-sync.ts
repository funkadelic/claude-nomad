import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { HOME, REPO_HOME, SUPPORTED_EXTRAS, type PathMap } from './config.ts';
import { listDivergingFiles } from './extras-sync.diff.ts';
import {
  copyExtras,
  eachExtrasTarget,
  loadValidatedExtras,
  type ExtrasCounts,
  type ValidatedExtras,
} from './extras-sync.core.ts';
import { assertSafeLogical } from './extras-sync.guards.ts';
import { warn } from './utils.ts';
import { encodePath } from './utils.json.ts';

// Re-export the shared primitives so existing import sites that pull them from
// `./extras-sync.ts` (tests call `copyExtras` directly) keep working unchanged.
export { copyExtras, eachExtrasTarget, loadValidatedExtras };
export type { ExtrasCounts, ValidatedExtras };

// The two public remap ops live in the sibling module to hold the soft
// line-cap; re-exported here so `./extras-sync.ts` stays the public surface.
export { remapExtrasPull, remapExtrasPush } from './extras-sync.remap.ts';

/**
 * Repo-relative `shared/extras/<logical>/<dirname>` paths for every (logical,
 * whitelisted dirname) pair in `map.extras`. The same prefix set the push
 * allow-list permits (minus the trailing slash, so usable directly as
 * `git add` args). Used by the fork update path (issue #112) to pre-commit
 * overlapping extras before `git merge upstream/main`, turning an
 * untracked-overwrite abort into a tracked-file merge. Non-whitelisted
 * dirnames are filtered out; logical names are validated for path-traversal
 * safety first, matching the `remapExtras*` contract.
 *
 * @param map - Parsed `path-map.json`. A missing `extras` key yields `[]`.
 * @returns Sorted, de-duplicated repo-relative extras paths (no trailing slash).
 */
export function whitelistedExtrasPaths(map: PathMap): string[] {
  const extrasMap = map.extras ?? {};
  const whitelist: readonly string[] = SUPPORTED_EXTRAS;
  const paths = new Set<string>();
  for (const [logical, dirnames] of Object.entries(extrasMap)) {
    assertSafeLogical(logical);
    for (const dirname of dirnames) {
      if (!whitelist.includes(dirname)) continue;
      paths.add(`shared/extras/${logical}/${dirname}`);
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

/**
 * Read-only pre-pull check: compare local `<localRoot>/<dirname>/` against
 * the just-pulled `shared/extras/<logical>/<dirname>/` and emit a WARN per
 * diverging file plus a count summary. Runs AFTER `git pull --rebase` and
 * BEFORE `remapExtrasPull` (so local state is intact for comparison).
 * Non-blocking per the inherited LWW model; the WARN names the per-project
 * `~/.cache/claude-nomad/backup/<ts>/extras/<encoded-localRoot>/` path that
 * `remapExtrasPull` will write to (the `<encoded-localRoot>` namespace mirrors
 * `backupExtrasWrite`, so same-relative-path projects do not collide). Silent
 * skip on missing path-map, no `extras` key, missing/`'TBD'` host path,
 * non-whitelisted dirname, or either side absent.
 */
export function divergenceCheckExtras(ts: string): void {
  const v = loadValidatedExtras({});
  if (v === null) return;

  const counts: ExtrasCounts = { unmapped: 0, skipped: 0 };
  const backupRoot = join(HOME, '.cache', 'claude-nomad', 'backup', ts, 'extras');
  for (const { logical, localRoot, dirname } of eachExtrasTarget(v, counts, true)) {
    const local = join(localRoot, dirname);
    const repo = join(REPO_HOME, 'shared', 'extras', logical, dirname);
    if (!existsSync(local) || !existsSync(repo)) continue;
    const diff = listDivergingFiles(local, repo);
    if (diff.length === 0) continue;
    const projectBackupRoot = join(backupRoot, encodePath(localRoot));
    warn(
      `local ${dirname} for ${logical} diverges from origin in ${diff.length} file(s); next remapExtrasPull will overwrite them (backups at ${projectBackupRoot}/)`,
    );
    for (const f of diff) warn(`  ${f}`);
  }
}
