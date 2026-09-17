import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { repoHome } from '../../core/config.ts';
import {
  copyExtrasFileSkipDiverged,
  copyExtrasFiltered,
  copyExtrasFilteredPreserving,
  copyExtrasOverlayFiltered,
  copyExtrasOverlaySkipDiverged,
  eachExtrasTarget,
  extrasDenySet,
  loadValidatedExtras,
  type ExtrasCounts,
  type ExtrasTarget,
  type ValidatedExtras,
} from './core.ts';
import { listDivergingModified } from './diff.ts';
import { propagatePlanningDeletes } from './planning-deletes.ts';
import { backupExtrasWrite, backupRepoWrite } from '../../core/utils.fs.ts';

export { keptDeletePreview, keptDeleteWarnLine } from './planning-deletes.ts';

/** Detail lists returned by an extras op: items copied (wet) and would-copy (dry). */
type ExtrasDetail = ExtrasCounts & { done: string[]; would: string[] };

/**
 * Shared copy loop for `remapExtrasPush` / `remapExtrasPull`. Walks every
 * surviving extras target (counts mutated via `eachExtrasTarget`; skips are
 * counted silently, no per-skip log line), resolves src/dst through the
 * side-specific `paths(...)`, and either records the would-copy item under
 * `dryRun` or backs up + copies and records the done item. Returns
 * `{ unmapped, skipped, done, would }`; the public wrappers rename
 * `done`/`would` to push/pull-specific field names. No per-item log lines: the
 * detail arrays carry that information to the tree renderer.
 *
 * @param v - validated path-map plus its extras block.
 * @param dryRun - when `true`, collect `would` without mutating.
 * @param paths - resolves `{ src, dst }` for one target (side-specific).
 * @param backup - snapshots the dst before clobber (side-specific).
 * @param copy - copy function, receiving the target `dirname` so it can pick a
 *   per-extra copy variant. Push routes `.planning` through
 *   `copyExtrasOverlayFiltered` (overlay-only with deny-set filter; repo-only
 *   files survive) and all other extras through `copyExtrasFiltered` (their
 *   `extrasDenySet`). Pull routes `.claude` through
 *   `copyExtrasFilteredPreserving` (preserves host-local deny-set files already
 *   on disk at any depth, e.g. `settings.local.json`, while still recursively
 *   mirror-pruning synced files absent from src), routes `.planning` through
 *   `copyExtrasOverlaySkipDiverged` (additive/overwrite so local-only files
 *   survive, but a file whose local copy diverges from the repo copy is kept
 *   local; the git-diff delete pass in `remapExtrasPull` propagates upstream
 *   deletions separately), and routes every other extra (a single root-level
 *   file, e.g. `CLAUDE.md`) through `copyExtrasFileSkipDiverged` so a
 *   locally-edited file is kept rather than clobbered. Filtering `.planning` on
 *   both sides is defense-in-depth:
 *   push prevents ALWAYS_NEVER_SYNC files from entering the repo working tree
 *   before the allow-list gate; pull guards against a repo poisoned out-of-band.
 * @returns the counts plus the done/would detail lists.
 */
function runExtrasOp(
  v: ValidatedExtras,
  dryRun: boolean,
  paths: (t: ExtrasTarget) => { src: string; dst: string },
  backup: (dst: string, localRoot: string) => void,
  copy: (src: string, dst: string, dirname: string) => void,
): ExtrasDetail {
  const counts: ExtrasCounts = { unmapped: 0, skipped: 0 };
  const done: string[] = [];
  const would: string[] = [];
  for (const t of eachExtrasTarget(v, counts)) {
    const { src, dst } = paths(t);
    if (!existsSync(src)) continue;
    const item = `${t.logical}/${t.dirname}`;
    if (dryRun) {
      would.push(item);
      continue;
    }
    backup(dst, t.localRoot);
    copy(src, dst, t.dirname);
    done.push(item);
  }
  return { ...counts, done, would };
}

/**
 * Push: copy whitelisted extras directories under each project's localRoot
 * into the repo at `shared/extras/<logical>/<dirname>/`. Returns
 * `{ unmapped, skipped, pushed, wouldPush }` with intentionally asymmetric
 * count granularity (see `eachExtrasTarget`): `unmapped` per-project, `skipped`
 * per-dirname; both feed the summary row. `pushed` / `wouldPush` hold
 * `<logical>/<dirname>` strings copied (wet) or that would copy under
 * `opts.dryRun` so cmdPush can render a grouped tree. Skips are counted
 * silently and per-item log lines are dropped; counts are unchanged. Legacy
 * `path-map.json` without an `extras` key returns empty arrays and zero counts
 * cleanly.
 *
 * Copy semantics per extra type:
 * - `.planning`: filtered overlay (`copyExtrasOverlayFiltered`; no `rmSync`).
 *   A repo-side file absent locally survives the push; local edits still
 *   propagate (overlay overwrites). The deny-set filter strips
 *   ALWAYS_NEVER_SYNC basenames at the copy layer (defense-in-depth before
 *   the allow-list gate), preventing secret residue from accumulating in the
 *   repo working tree between push invocations. Push-side delete detection is
 *   DEFERRED (per-host last-synced manifest, backlog candidate). The
 *   allow-list gate (`enforceAllowList`) remains the security boundary.
 * - All others: `copyExtrasFiltered` with per-extra denylist (`.claude` gets
 *   the full `NEVER_SYNC` boundary; others get the narrow `ALWAYS_NEVER_SYNC`
 *   subset). This is the existing exact-mirror (rmSync-before-copy) behavior.
 *
 * @param ts - backup timestamp namespace.
 * @param opts.dryRun - when `true`, collect `wouldPush` without mutating.
 */
export function remapExtrasPush(
  ts: string,
  opts: { dryRun?: boolean } = {},
): ExtrasCounts & { pushed: string[]; wouldPush: string[] } {
  const dryRun = opts.dryRun === true;
  const v = loadValidatedExtras({ missingMsg: 'no path-map.json; skipping extras push' });
  if (v === null) return { unmapped: 0, skipped: 0, pushed: [], wouldPush: [] };

  const repo = repoHome();
  const repoExtras = join(repo, 'shared', 'extras');
  if (!dryRun) mkdirSync(repoExtras, { recursive: true });

  const { unmapped, skipped, done, would } = runExtrasOp(
    v,
    dryRun,
    ({ localRoot, logical, dirname }) => ({
      src: join(localRoot, dirname),
      dst: join(repoExtras, logical, dirname),
    }),
    (dst) => backupRepoWrite(dst, ts, repo),
    // Push copy routing per extra type:
    //   `.planning`: copyExtrasOverlayFiltered (no rmSync; deny-set filtered).
    //     Repo-only files survive; local edits propagate (overlay overwrites).
    //     The filter prevents ALWAYS_NEVER_SYNC files from landing in the repo
    //     working tree before the allow-list gate fires, eliminating the
    //     "residue wedges repeat push" regression. The allow-list gate
    //     (enforceAllowList in commands/push/allowlist.ts, blockSetFor in
    //     config.never-sync.ts)
    //     remains the hard security boundary.
    //   All others: copyExtrasFiltered with per-extra denylist.
    (src, dst, dirname) =>
      dirname === '.planning'
        ? copyExtrasOverlayFiltered(src, dst, extrasDenySet(dirname))
        : copyExtrasFiltered(src, dst, extrasDenySet(dirname)),
  );
  return { unmapped, skipped, pushed: done, wouldPush: would };
}

/**
 * Pull: copy whitelisted extras from `shared/extras/<logical>/<dirname>/`
 * back into each project's localRoot on this host. Returns
 * `{ unmapped, skipped, pulled, wouldPull }` with the same asymmetric count
 * granularity as `remapExtrasPush`; `pulled` / `wouldPull` hold
 * `<logical>/<dirname>` strings for the grouped tree. Skips are counted
 * silently and per-item log lines are dropped; counts are unchanged. Uses
 * `backupExtrasWrite` (not `backupBeforeWrite`) because
 * `<localRoot>/<dirname>` lives outside `CLAUDE_HOME` and the standard helper's
 * relative-path guard would no-op and lose prior content. Legacy
 * `path-map.json` without an `extras` key, or a missing `shared/extras/`, both
 * produce a clean no-op.
 *
 * `.planning` extras use an overlay-then-delete-propagation model:
 * `copyExtrasOverlaySkipDiverged` (no upfront rmSync; deny-set filtered) keeps
 * local-only files alive and skips any file whose local copy diverges from the
 * repo copy (content hash differs) so a local hand-edit wins on conflict, and
 * the optional `prePostHeads` pair drives a targeted delete pass based on
 * `git diff --name-status -z <pre> <post>`. The delete pass is symmetric with
 * the modify path: a file deleted upstream but edited locally since the last
 * sync is KEPT (a delete-vs-edit conflict the user pushes to reconcile), not
 * removed. Without `prePostHeads` (fresh clone / unborn HEAD), only the overlay
 * runs and nothing is deleted.
 *
 * @param ts - backup timestamp namespace.
 * @param opts.dryRun - when `true`, collect `wouldPull` without mutating; no
 *   overlay, no git diff, no deletes.
 * @param opts.prePostHeads - pre/post-rebase REPO_HOME HEADs captured by
 *   `cmdPull`; drives the upstream-deletion propagation for `.planning` extras.
 *   When absent, the delete pass is skipped entirely.
 */
export function remapExtrasPull(
  ts: string,
  opts: { dryRun?: boolean; prePostHeads?: { pre: string; post: string } } = {},
): ExtrasCounts & { pulled: string[]; wouldPull: string[] } {
  const dryRun = opts.dryRun === true;
  const { prePostHeads } = opts;
  const v = loadValidatedExtras({
    requireRepoExtras: true,
    missingMsg: 'no path-map or repo extras dir; skipping extras remap',
  });
  if (v === null) return { unmapped: 0, skipped: 0, pulled: [], wouldPull: [] };

  const repo = repoHome();
  const { unmapped, skipped, done, would } = runExtrasOp(
    v,
    dryRun,
    ({ localRoot, logical, dirname }) => ({
      src: join(repo, 'shared', 'extras', logical, dirname),
      dst: join(localRoot, dirname),
    }),
    // Snapshot the host-side dst BEFORE the copy step touches it. Anchor on
    // localRoot so the backup tree mirrors the project layout.
    (dst, localRoot) => backupExtrasWrite(dst, ts, localRoot),
    // Pull routing per extra type:
    //   `.claude`: copyExtrasFilteredPreserving preserves host-local deny-set
    //     files (e.g. settings.local.json) while mirror-pruning synced entries.
    //   `.planning`: copyExtrasOverlaySkipDiverged (no rmSync; deny-set filtered)
    //     keeps local-only files AND skips any file whose local copy diverges
    //     from the repo copy (content hash differs), so a local hand-edit wins
    //     on conflict; the delete pass below still propagates
    //     upstream removals via the git-diff D set. The filter is defense-in-
    //     depth against a repo poisoned out-of-band.
    //   All others (a single root-level file, e.g. CLAUDE.md):
    //     copyExtrasFileSkipDiverged keeps a locally-edited file rather than
    //     clobbering it, so the divergence WARN's keep-local promise holds for
    //     every extra, not just `.planning`.
    (src, dst, dirname) => {
      if (dirname === '.claude')
        return copyExtrasFilteredPreserving(src, dst, extrasDenySet(dirname));
      if (dirname === '.planning') {
        // divergedSet is the both-sides-modified set (local dst vs repo src);
        // those files are preserved local rather than overwritten.
        const divergedSet = new Set(listDivergingModified(dst, src));
        return copyExtrasOverlaySkipDiverged(src, dst, extrasDenySet(dirname), divergedSet);
      }
      return copyExtrasFileSkipDiverged(src, dst);
    },
  );

  // Delete-propagation pass for .planning: run the git-diff D set against
  // each target's localRoot to remove files deleted upstream. Skipped
  // entirely on dryRun (zero-mutation contract) and when prePostHeads is
  // absent (fresh clone / no pre-state). The backup inside
  // propagatePlanningDeletes guarantees a snapshot exists before any delete
  // even when the overlay was skipped (src absent).
  if (!dryRun && prePostHeads !== undefined) {
    propagatePlanningDeletes(v, ts, prePostHeads, repo);
  }

  return { unmapped, skipped, pulled: done, wouldPull: would };
}
