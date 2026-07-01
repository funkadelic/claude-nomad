import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { backupBase, repoHome } from './config.ts';
import { listDivergingModified } from './extras-sync.diff.ts';
import { eachExtrasTarget, loadValidatedExtras, type ExtrasCounts } from './extras-sync.core.ts';
import { warn } from './utils.ts';
import { encodePath } from './utils.json.ts';

// Re-export `copyExtras` so existing import sites that pull it from
// `./extras-sync.ts` (tests call it directly) keep working unchanged.
export { copyExtras } from './extras-sync.core.ts';

// The two public remap ops live in the sibling module to hold the soft
// line-cap; re-exported here so `./extras-sync.ts` stays the public surface.
export { remapExtrasPull, remapExtrasPush } from './extras-sync.remap.ts';
import { keptDeletePreview, keptDeleteWarnLine } from './extras-sync.remap.ts';

/**
 * Build the user-facing WARN line for one diverging extra. Phrases the entry
 * as a "folder"/"file" with grammar that agrees with the diverging-file count
 * (singular vs plural), and names the backup path the next pull step writes to.
 * The wording reflects the divergence-is-conflict guard: the pull KEEPS the
 * local copy on divergence rather than overwriting it, so the user pushes to
 * reconcile. The backup snapshot is still taken (defense-in-depth).
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
  const yours = one ? 'your current file is' : 'your current files are';
  return `local ${kind} ${name} in repo ${o.logical} differs from the synced copy in ${fileCount}; the next pull step will keep your local copy (push to reconcile; ${yours} backed up to ${o.projectBackupRoot}/)`;
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
 *
 * When `prePostHeads` is supplied (the `pull --dry-run` path, which has rebased
 * and captured the pre/post HEADs), the check also previews delete-vs-edit
 * keep-local cases: a `.planning` file deleted upstream but edited locally is
 * kept by the real pull, so the same WARN is surfaced here. Offline `nomad diff`
 * omits `prePostHeads` (it cannot foresee an upstream deletion without a fetch),
 * and the WET pull emits that WARN from `remapExtrasPull` itself, so passing the
 * heads only for `--dry-run` avoids a double WARN.
 */
export function divergenceCheckExtras(
  ts: string,
  prePostHeads?: { pre: string; post: string },
): void {
  const v = loadValidatedExtras({});
  if (v === null) return;

  const counts: ExtrasCounts = { unmapped: 0, skipped: 0 };
  const backupRoot = join(backupBase(), ts, 'extras');
  const repo = repoHome();
  for (const { logical, localRoot, dirname } of eachExtrasTarget(v, counts)) {
    const local = join(localRoot, dirname);
    const repoEntry = join(repo, 'shared', 'extras', logical, dirname);
    if (!existsSync(local) || !existsSync(repoEntry)) continue;
    // Only both-sides-modified (M) files are kept-local-on-conflict by the pull.
    // Repo-only (A) files are added by the pull and local-only (D) files survive
    // regardless, so neither is a conflict; counting them would over-state the
    // keep-local reassurance (the honest-count goal).
    const modified = listDivergingModified(local, repoEntry);
    if (modified.length === 0) continue;
    const projectBackupRoot = join(backupRoot, encodePath(localRoot));
    warn(
      divergenceWarnLine({
        dirname,
        logical,
        isDir: statSync(local).isDirectory(),
        count: modified.length,
        projectBackupRoot,
      }),
    );
    for (const f of modified) warn(`  ${f}`);
  }

  // Delete-vs-edit keep-local preview (dry-run only; see the JSDoc note above).
  if (prePostHeads !== undefined) {
    for (const { logical, relToLocal } of keptDeletePreview(v, prePostHeads, repo)) {
      warn(keptDeleteWarnLine(logical, relToLocal));
    }
  }
}
