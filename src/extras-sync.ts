import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { BACKUP_BASE, REPO_HOME } from './config.ts';
import { listDivergingFiles } from './extras-sync.diff.ts';
import { eachExtrasTarget, loadValidatedExtras, type ExtrasCounts } from './extras-sync.core.ts';
import { warn } from './utils.ts';
import { encodePath } from './utils.json.ts';

// Re-export `copyExtras` so existing import sites that pull it from
// `./extras-sync.ts` (tests call it directly) keep working unchanged.
export { copyExtras } from './extras-sync.core.ts';

// The two public remap ops live in the sibling module to hold the soft
// line-cap; re-exported here so `./extras-sync.ts` stays the public surface.
export { remapExtrasPull, remapExtrasPush } from './extras-sync.remap.ts';

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
  const backupRoot = join(BACKUP_BASE, ts, 'extras');
  for (const { logical, localRoot, dirname } of eachExtrasTarget(v, counts)) {
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
