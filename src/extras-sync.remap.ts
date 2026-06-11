import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { repoHome } from './config.ts';
import {
  copyExtras,
  copyExtrasFiltered,
  copyExtrasFilteredPreserving,
  copyExtrasOverlayFiltered,
  eachExtrasTarget,
  extrasDenySet,
  loadValidatedExtras,
  type ExtrasCounts,
  type ValidatedExtras,
} from './extras-sync.core.ts';
import { planningDeleteTargets } from './extras-sync.planning-diff.ts';
import { backupExtrasWrite, backupRepoWrite } from './utils.fs.ts';
import { gitCaptureRaw } from './utils.ts';

/** Detail lists returned by an extras op: items copied (wet) and would-copy (dry). */
type ExtrasDetail = ExtrasCounts & { done: string[]; would: string[] };

/** One yielded extras target: a (logical, host localRoot, dirname) triple. */
type ExtrasTarget = { logical: string; localRoot: string; dirname: string };

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
 *   `copyExtrasOverlayFiltered` (additive/overwrite so local-only files
 *   survive; the git-diff delete pass in `remapExtrasPull` propagates upstream
 *   deletions separately), and uses the exact-mirror `copyExtras` for every
 *   other extra. Filtering `.planning` on both sides is defense-in-depth:
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
 * Remove now-empty parent directories of `target` up to (but not including)
 * `planningRoot`. Stops as soon as a non-empty directory is encountered or
 * the planning root itself is reached. Silently ignores ENOENT (the directory
 * was already removed by a sibling delete).
 *
 * @param target - Host-side absolute path that was just deleted.
 * @param planningRoot - Absolute path of `localRoot/.planning`; the upward
 *   walk stops here and does not remove the planning root itself.
 */
function pruneEmptyAncestors(target: string, planningRoot: string): void {
  let dir = dirname(target);
  while (dir !== planningRoot && dir.startsWith(planningRoot + sep)) {
    try {
      if (readdirSync(dir).length > 0) break;
      // rmSync requires recursive:true to remove a directory (rmSync with
      // recursive:false maps to unlink(), which fails with EISDIR on dirs).
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* c8 ignore next */
      break; // ENOENT or other I/O error; stop pruning
    }
    dir = dirname(dir);
  }
}

/**
 * Resolve the real path of `dir`, returning `undefined` if the path does not
 * exist (ENOENT). Used by the delete-pass symlink guard to avoid crashing on
 * a missing parent directory (target already gone) or a missing planning root.
 *
 * @param dir - Absolute path to resolve.
 * @returns The real path string, or `undefined` on ENOENT.
 */
function tryRealpath(dir: string): string | undefined {
  try {
    return realpathSync(dir);
  } catch {
    /* c8 ignore next */
    return undefined; // ENOENT: path does not exist
  }
}

/**
 * Return `true` if `parentReal` is the same directory as `rootReal` or a
 * strict subdirectory of it (the parent lives inside the planning root). Used
 * to guard `rmSync` against deletion through an intermediate symlink (WR-03).
 *
 * @param parentReal - Resolved real path of the file's parent directory.
 * @param rootReal - Resolved real path of `localRoot/.planning`.
 * @returns `true` when the parent is inside or equal to the planning root.
 */
function isInsidePlanningRoot(parentReal: string, rootReal: string): boolean {
  return parentReal === rootReal || parentReal.startsWith(rootReal + sep);
}

/**
 * Delete one resolved target path after all safety checks pass, then prune
 * empty ancestor directories up to `planningRoot`.
 *
 * @param target - Host-side absolute path to delete (file or directory).
 * @param planningRoot - Absolute path of `localRoot/.planning`; ancestor
 *   pruning stops here.
 * @param repoCounterpart - Repo-side counterpart of `target`; if it still
 *   exists the delete is skipped (WR-04: case-only rename on macOS).
 */
function deletePlanningTarget(target: string, planningRoot: string, repoCounterpart: string): void {
  // WR-04: skip if the post-rebase repo still has this path (a case-only
  // rename on a case-insensitive filesystem resolves old name to the new
  // file, so deleting would undo what the overlay just wrote).
  if (existsSync(repoCounterpart)) return;

  // WR-03: verify the parent's real path is inside the planning root,
  // guarding against deletion through an intermediate symlink.
  const parentReal = tryRealpath(dirname(target));
  if (parentReal === undefined) return; // parent gone; target already missing
  const rootReal = tryRealpath(planningRoot);
  if (rootReal === undefined) return; // planning root gone; nothing to do
  if (!isInsidePlanningRoot(parentReal, rootReal)) return;

  rmSync(target, { recursive: true, force: true });
  pruneEmptyAncestors(target, planningRoot);
}

/**
 * Propagate upstream `.planning` deletions from the git diff D set into the
 * host-side project tree. For each `.planning` extras target in `v`, runs
 * `git diff --name-status -z <pre> <post>` to find files deleted upstream
 * and removes them from `localRoot`. A backup snapshot is taken before the
 * first deletion so locally-diverged edits can be recovered.
 *
 * @param v - Validated path-map plus its extras block.
 * @param ts - Backup timestamp namespace.
 * @param prePostHeads - Pre/post-rebase HEAD SHAs from `cmdPull`.
 * @param repo - Absolute path to REPO_HOME.
 */
function propagatePlanningDeletes(
  v: ValidatedExtras,
  ts: string,
  prePostHeads: { pre: string; post: string },
  repo: string,
): void {
  const repoExtras = join(repo, 'shared', 'extras');
  for (const t of eachExtrasTarget(v, { unmapped: 0, skipped: 0 })) {
    if (t.dirname !== '.planning') continue;
    const raw = gitCaptureRaw(
      [
        'diff',
        '--name-status',
        '-z',
        prePostHeads.pre,
        prePostHeads.post,
        '--',
        `shared/extras/${t.logical}/.planning/`,
      ],
      repo,
    );
    const targets = planningDeleteTargets({ raw, logical: t.logical, localRoot: t.localRoot });
    if (targets.length === 0) continue;

    // Snapshot the host-side .planning tree before any delete so locally-
    // diverged edits can be recovered. cpSync force:false makes this
    // idempotent if the overlay already took a snapshot for this ts.
    backupExtrasWrite(join(t.localRoot, t.dirname), ts, t.localRoot);

    const planningRoot = join(t.localRoot, '.planning');
    for (const target of targets) {
      const relToLocal = target.slice(t.localRoot.length + sep.length);
      deletePlanningTarget(target, planningRoot, join(repoExtras, t.logical, relToLocal));
    }
  }
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
    //     "residue wedges repeat push" regression (WR-02). The allow-list gate
    //     (enforceAllowList / blockSetFor in commands.push.allowlist.ts)
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
 * `copyExtrasOverlayFiltered` (no upfront rmSync; deny-set filtered) keeps
 * local-only files alive, and the optional `prePostHeads` pair drives a
 * targeted delete pass based on `git diff --name-status -z <pre> <post>`.
 * Without `prePostHeads` (fresh clone / unborn HEAD), only the overlay runs
 * and nothing is deleted.
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
    // Snapshot the host-side dst BEFORE copyExtras clobbers it. Anchor on
    // localRoot so the backup tree mirrors the project layout.
    (dst, localRoot) => backupExtrasWrite(dst, ts, localRoot),
    // Pull routing per extra type:
    //   `.claude`: copyExtrasFilteredPreserving preserves host-local deny-set
    //     files (e.g. settings.local.json) while mirror-pruning synced entries.
    //   `.planning`: copyExtrasOverlayFiltered (no rmSync; deny-set filtered)
    //     keeps local-only files; the delete pass below propagates upstream
    //     removals via the git-diff D set. The filter is defense-in-depth
    //     against a repo poisoned out-of-band.
    //   All others: copyExtras (exact mirror; rarely carry host-local files).
    (src, dst, dirname) => {
      if (dirname === '.claude')
        return copyExtrasFilteredPreserving(src, dst, extrasDenySet(dirname));
      if (dirname === '.planning')
        return copyExtrasOverlayFiltered(src, dst, extrasDenySet(dirname));
      return copyExtras(src, dst);
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
