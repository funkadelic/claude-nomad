import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { repoHome } from './config.ts';
import {
  copyExtras,
  copyExtrasFiltered,
  copyExtrasFilteredPreserving,
  copyExtrasOverlay,
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
 *   `copyExtrasOverlay` (overlay-only; repo-only files survive) and all other
 *   extras through `copyExtrasFiltered` (their `extrasDenySet`). Pull routes `.claude` through
 *   `copyExtrasFilteredPreserving` (preserves host-local deny-set files already
 *   on disk at any depth, e.g. `settings.local.json`, while still recursively
 *   mirror-pruning synced files absent from src), routes `.planning` through
 *   `copyExtrasOverlay` (additive/overwrite so local-only files survive; the
 *   git-diff delete pass in `remapExtrasPull` propagates upstream deletions
 *   separately), and uses the exact-mirror `copyExtras` for every other extra.
 *   Filtering `.claude` on pull is defense-in-depth against a repo poisoned
 *   out-of-band (manual commit, older CLI): the deny-set src filter still
 *   strips blocked basenames from the copy even with the preserving variant.
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
 * - `.planning`: overlay-only (`copyExtrasOverlay`; no `rmSync`). A repo-side
 *   file absent locally survives the push; local edits still propagate (overlay
 *   overwrites). Push-side delete detection is DEFERRED (per-host last-synced
 *   manifest, backlog candidate). ALWAYS_NEVER_SYNC names are blocked at the
 *   push allow-list gate, not the copy layer (the gate is the security boundary).
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
    //   `.planning`: copyExtrasOverlay (no rmSync) so repo-only files (absent
    //     locally) survive the push. Local edits still propagate (overlay
    //     overwrites existing repo entries). Push-side delete detection is
    //     DEFERRED by design (per-host last-synced manifest, backlog candidate).
    //     Security note: the ALWAYS_NEVER_SYNC deny-set previously applied by
    //     copyExtrasFiltered is now enforced exclusively at the push gate
    //     (enforceAllowList / blockSetFor in commands.push.allowlist.ts), which
    //     hard-blocks ALWAYS_NEVER_SYNC basenames inside shared/extras/ regardless
    //     of copy-side filtering. The gate is the security boundary (CLAUDE.md /
    //     Phase 33 audit F4); bare overlay is therefore safe for .planning.
    //   All others: copyExtrasFiltered with per-extra denylist (`.claude` gets
    //     CLAUDE_EXTRA_NEVER_SYNC; every other extra gets ALWAYS_NEVER_SYNC).
    (src, dst, dirname) =>
      dirname === '.planning'
        ? copyExtrasOverlay(src, dst)
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
 * `copyExtrasOverlay` (no upfront rmSync) keeps local-only files alive, and
 * the optional `prePostHeads` pair drives a targeted delete pass based on
 * `git diff --name-status -z <pre> <post>`. Without `prePostHeads` (fresh
 * clone / unborn HEAD), only the overlay runs and nothing is deleted.
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
  const repoExtras = join(repo, 'shared', 'extras');
  const { unmapped, skipped, done, would } = runExtrasOp(
    v,
    dryRun,
    ({ localRoot, logical, dirname }) => ({
      src: join(repoExtras, logical, dirname),
      dst: join(localRoot, dirname),
    }),
    // Snapshot the host-side dst BEFORE copyExtras clobbers it. Anchor on
    // localRoot so the backup tree mirrors the project layout.
    (dst, localRoot) => backupExtrasWrite(dst, ts, localRoot),
    // Pull routing per extra type:
    //   `.claude`: copyExtrasFilteredPreserving preserves host-local deny-set
    //     files (e.g. settings.local.json) while mirror-pruning synced entries.
    //   `.planning`: copyExtrasOverlay (no rmSync) keeps local-only files; the
    //     delete pass below propagates upstream removals via the git-diff D set.
    //   All others: copyExtras (exact mirror; rarely carry host-local files).
    (src, dst, dirname) => {
      if (dirname === '.claude')
        return copyExtrasFilteredPreserving(src, dst, extrasDenySet(dirname));
      if (dirname === '.planning') return copyExtrasOverlay(src, dst);
      return copyExtras(src, dst);
    },
  );

  // Delete-propagation pass for .planning: run the git-diff D set against
  // each target's localRoot to remove files deleted upstream. This runs after
  // the overlay so the copy and the delete are both visible in the same
  // invocation. Skipped entirely on dryRun (zero-mutation contract) and when
  // prePostHeads is absent (fresh clone / no pre-state).
  if (!dryRun && prePostHeads !== undefined) {
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
      for (const target of targets) {
        rmSync(target, { recursive: true, force: true });
      }
    }
  }

  return { unmapped, skipped, pulled: done, wouldPull: would };
}
