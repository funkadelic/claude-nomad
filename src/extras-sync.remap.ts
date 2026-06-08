import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { repoHome } from './config.ts';
import {
  copyExtras,
  copyExtrasFiltered,
  eachExtrasTarget,
  extrasDenySet,
  loadValidatedExtras,
  type ExtrasCounts,
  type ValidatedExtras,
} from './extras-sync.core.ts';
import { backupExtrasWrite, backupRepoWrite } from './utils.fs.ts';

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
 *   per-extra denylist. Push passes a filtered copy for every extra (each by
 *   its `extrasDenySet`). Pull filters only `.claude` (whose tree can carry
 *   per-host state like `settings.local.json`) and uses the exact-mirror
 *   `copyExtras` for the others: a clean repo makes the filter a no-op, and the
 *   exact mirror is the documented restore semantics for `.planning`. Filtering
 *   `.claude` on pull is defense-in-depth against a repo poisoned out-of-band
 *   (manual commit, older CLI) restoring a blocked file onto the host.
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
    // Push filters every extra by its per-name denylist: `.claude` gets the
    // full NEVER_SYNC boundary, `.planning` keeps the narrow ALWAYS_NEVER_SYNC.
    (src, dst, dirname) => copyExtrasFiltered(src, dst, extrasDenySet(dirname)),
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
 * @param ts - backup timestamp namespace.
 * @param opts.dryRun - when `true`, collect `wouldPull` without mutating.
 */
export function remapExtrasPull(
  ts: string,
  opts: { dryRun?: boolean } = {},
): ExtrasCounts & { pulled: string[]; wouldPull: string[] } {
  const dryRun = opts.dryRun === true;
  const v = loadValidatedExtras({
    requireRepoExtras: true,
    missingMsg: 'no path-map or repo extras dir; skipping extras remap',
  });
  if (v === null) return { unmapped: 0, skipped: 0, pulled: [], wouldPull: [] };

  const repoExtras = join(repoHome(), 'shared', 'extras');
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
    // Pull filters `.claude` against its NEVER_SYNC boundary so a repo poisoned
    // out-of-band cannot restore a blocked per-host file (e.g. settings.local.json)
    // onto this host. Other extras use the exact-mirror copyExtras: the repo is
    // clean once push filters, and exact mirror is the documented restore for
    // `.planning`.
    (src, dst, dirname) =>
      dirname === '.claude'
        ? copyExtrasFiltered(src, dst, extrasDenySet(dirname))
        : copyExtras(src, dst),
  );
  return { unmapped, skipped, pulled: done, wouldPull: would };
}
