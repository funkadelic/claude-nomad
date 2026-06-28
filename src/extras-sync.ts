import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { backupBase, repoHome } from './config.ts';
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
 * Build the user-facing WARN line for one diverging extra. Phrases the entry
 * as a "folder"/"file" with grammar that agrees with the diverging-file count
 * (singular vs plural), and names the backup path the next pull step writes to.
 */
function divergenceWarnLine(o: {
  dirname: string;
  logical: string;
  isDir: boolean;
  count: number;
  projectBackupRoot: string;
}): string {
  const kind = o.isDir ? 'folder' : 'file';
  const name = o.isDir ? `${o.dirname}/` : o.dirname;
  const one = o.count === 1;
  const fileCount = one ? '1 file' : `${o.count} files`;
  const them = one ? 'it' : 'them';
  const yours = one ? 'your current file is' : 'your current files are';
  return `local ${kind} ${name} in repo ${o.logical} differs from the synced copy in ${fileCount}; the next pull step will overwrite ${them} with the synced version (${yours} backed up to ${o.projectBackupRoot}/)`;
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
  const backupRoot = join(backupBase(), ts, 'extras');
  const repo = repoHome();
  for (const { logical, localRoot, dirname } of eachExtrasTarget(v, counts)) {
    const local = join(localRoot, dirname);
    const repoEntry = join(repo, 'shared', 'extras', logical, dirname);
    if (!existsSync(local) || !existsSync(repoEntry)) continue;
    const diff = listDivergingFiles(local, repoEntry);
    if (diff.length === 0) continue;
    const projectBackupRoot = join(backupRoot, encodePath(localRoot));
    warn(
      divergenceWarnLine({
        dirname,
        logical,
        isDir: statSync(local).isDirectory(),
        count: diff.length,
        projectBackupRoot,
      }),
    );
    for (const f of diff) warn(`  ${f}`);
  }
}
