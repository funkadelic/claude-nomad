import { existsSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

import { backupBase, deniedSegmentFor, isClaudeExtraName, repoHome } from '../../core/config.ts';
import { listDivergingModified } from './diff.ts';
import { eachExtrasTarget, loadValidatedExtras, type ExtrasCounts } from './core.ts';
import { warn } from '../../core/utils.ts';
import { encodePath } from '../../core/utils.json.ts';

// Re-export `copyExtras` so import sites that pull it from this module's public
// surface (`src/commands/push/preview.ts`) keep working unchanged.
export { copyExtras } from './core.ts';

// The two public remap ops live in the sibling module to hold the soft
// line-cap; re-exported here so `./extras.ts` stays the public surface.
export { remapExtrasPull, remapExtrasPush } from './remap.ts';
import { keptDeletePreview, keptDeleteWarnLine } from './remap.ts';

/** Diverged-file counts by what the pull does with them. */
export type DivergenceCounts = { keptLocal: number; replaced: number };

/**
 * Diverged files the pull actually overwrites. The `.claude` pull preserves
 * deny-set names and skips root `worktrees/`, so those are dropped here.
 */
function pullOverwritten(logical: string, dirname: string, modified: string[]): string[] {
  if (!isClaudeExtraName(dirname)) return modified;
  const repoRel = (f: string) => `shared/extras/${logical}/${dirname}/${f.split(sep).join('/')}`;
  return modified.filter((f) => deniedSegmentFor(repoRel(f)) === null);
}

/**
 * Build the user-facing WARN line for one diverging extra. Phrases the entry
 * as a "folder"/"file" with grammar that agrees with the diverging-file count
 * (singular vs plural), and names the backup path the next pull step writes to.
 * `.planning` and root files keep the local copy on divergence; the `.claude`
 * extra pull overwrites synced files, so its line says so and tells the user
 * to push first. The backup snapshot is taken either way. A preview
 * writes no backup, and the real pull picks its own timestamp, so the preview
 * wording names no path.
 */
function divergenceWarnLine(o: {
  dirname: string;
  logical: string;
  isDir: boolean;
  count: number;
  projectBackupRoot: string;
  dryRun: boolean;
}): string {
  const kind = o.isDir ? 'folder' : 'file';
  const name = o.isDir ? `${o.dirname}/` : o.dirname;
  const one = o.count === 1;
  const fileCount = one ? '1 file' : `${o.count} files`;
  const yours = one ? 'your current file' : 'your current files';
  const verb = one ? 'is' : 'are';
  const backup = o.dryRun
    ? 'will be backed up when you pull'
    : `${verb} backed up to ${o.projectBackupRoot}/`;
  const outcome = isClaudeExtraName(o.dirname)
    ? 'will replace your local copy with the synced one (push first to keep your edits;'
    : 'will keep your local copy (push to reconcile;';
  return `local ${kind} ${name} in repo ${o.logical} differs from the synced copy in ${fileCount}; the next pull step ${outcome} ${yours} ${backup})`;
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
 *
 * @param ts - Backup timestamp namespace used to phrase the per-project backup
 *   path in the WARN line.
 * @param prePostHeads - Pre/post-rebase HEADs from the `--dry-run` path;
 *   `undefined` for the WET pull and offline `nomad diff`.
 * @param dryRun - `true` for `pull --dry-run` and `nomad diff`, which write no
 *   backup, so the WARN does not name a backup path.
 * @returns Both-sides-modified (M) file counts across every diverging extra,
 *   split into files the pull keeps local and `.claude` files it replaces with
 *   the repo copy. Callers that only need the WARN output may ignore it.
 */
export function divergenceCheckExtras(
  ts: string,
  prePostHeads?: { pre: string; post: string },
  dryRun = false,
): DivergenceCounts {
  const total: DivergenceCounts = { keptLocal: 0, replaced: 0 };
  const v = loadValidatedExtras({});
  if (v === null) return total;

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
    const modified = pullOverwritten(logical, dirname, listDivergingModified(local, repoEntry));
    if (modified.length === 0) continue;
    if (isClaudeExtraName(dirname)) total.replaced += modified.length;
    else total.keptLocal += modified.length;
    const projectBackupRoot = join(backupRoot, encodePath(localRoot));
    warn(
      divergenceWarnLine({
        dirname,
        logical,
        isDir: statSync(local).isDirectory(),
        count: modified.length,
        projectBackupRoot,
        dryRun,
      }),
    );
    for (const f of modified) warn(`  ${f}`);
  }

  // Delete-vs-edit keep-local preview (dry-run only; see the JSDoc note above).
  if (prePostHeads !== undefined) {
    for (const { logical, relToLocal } of keptDeletePreview(v, prePostHeads, repo)) {
      warn(keptDeleteWarnLine(logical, relToLocal, dryRun));
    }
  }
  return total;
}
