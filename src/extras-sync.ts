import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { HOME, HOST, REPO_HOME, SUPPORTED_EXTRAS, type PathMap } from './config.ts';
import { listDivergingFiles } from './extras-sync.diff.ts';
import { assertSafeLocalRoot, assertSafeLogical } from './extras-sync.guards.ts';
import { log, warn } from './utils.ts';
import { backupExtrasWrite, backupRepoWrite } from './utils.fs.ts';
import { encodePath, readPathMap } from './utils.json.ts';

/** Parsed `path-map.json` plus its validated `extras` block. */
type ValidatedExtras = { map: PathMap; extrasMap: Record<string, string[]> };

/** Skip counts: `unmapped` per-project (no host path / `'TBD'`), `skipped` per-dirname (not whitelisted). */
type ExtrasCounts = { unmapped: number; skipped: number };

/**
 * Load and validate `path-map.json` for an extras op, owning the guard order
 * so the "FATAL before any filesystem mutation" contract holds for every
 * caller. Returns the parsed map plus its `extras` block, or `null` on a clean
 * early-exit (missing `path-map.json`, a missing repo extras dir when
 * `requireRepoExtras`, or an empty/absent `extras` key). THE VALIDATION PASS
 * runs here, up-front over the whole map (`assertSafeLogical` per logical,
 * `assertSafeLocalRoot` per mapped non-`'TBD'` path) so a clean entry ahead of
 * a poisoned one cannot let a `mkdirSync`/`cpSync` land before the FATAL fires.
 *
 * @param opts.requireRepoExtras - Also require `shared/extras/` (pull side).
 * @param opts.missingMsg - `log()` line on the missing-prereq exit (omitted for
 *   the divergence check, which skips silently).
 */
function loadValidatedExtras(opts: {
  requireRepoExtras?: boolean;
  missingMsg?: string;
}): ValidatedExtras | null {
  const mapPath = join(REPO_HOME, 'path-map.json');
  const repoExtras = join(REPO_HOME, 'shared', 'extras');
  if (!existsSync(mapPath) || (opts.requireRepoExtras === true && !existsSync(repoExtras))) {
    if (opts.missingMsg !== undefined) log(opts.missingMsg);
    return null;
  }

  const map = readPathMap(mapPath);
  const extrasMap = map.extras ?? {};
  if (Object.keys(extrasMap).length === 0) return null;

  for (const logical of Object.keys(extrasMap)) {
    assertSafeLogical(logical);
    const localRoot = map.projects[logical]?.[HOST];
    if (localRoot && localRoot !== 'TBD') assertSafeLocalRoot(localRoot, logical);
  }
  return { map, extrasMap };
}

/**
 * Yield every surviving `{ logical, localRoot, dirname }` extras target after
 * the per-project and per-dirname skip filters, mutating `counts` as it goes
 * (`unmapped++` for a project with no host path / `'TBD'`, then skip it;
 * `skipped++` for a dirname outside `SUPPORTED_EXTRAS`). Shared by push, pull,
 * and the divergence check so all three walk identical skip/count semantics;
 * the caller builds src/dst from the yielded triple.
 *
 * @param quiet - Suppress the per-skip `log()` lines (the read-only divergence
 *   check skips silently; push/pull narrate). Counts increment either way.
 */
function* eachExtrasTarget(
  v: ValidatedExtras,
  counts: ExtrasCounts,
  quiet = false,
): Generator<{ logical: string; localRoot: string; dirname: string }> {
  const whitelist: readonly string[] = SUPPORTED_EXTRAS;
  for (const [logical, dirnames] of Object.entries(v.extrasMap)) {
    const localRoot = v.map.projects[logical]?.[HOST];
    if (!localRoot || localRoot === 'TBD') {
      counts.unmapped++;
      if (!quiet) log(`skip ${logical}: no path for ${HOST}`);
      continue;
    }
    for (const dirname of dirnames) {
      if (!whitelist.includes(dirname)) {
        counts.skipped++;
        if (!quiet) log(`skip ${dirname} for ${logical}: not in SUPPORTED_EXTRAS`);
        continue;
      }
      yield { logical, localRoot, dirname };
    }
  }
}

/**
 * Recursive mirror copy: `rmSync` then `cpSync` so dst-only entries are
 * removed (true mirror, not just overwrite). Passes `verbatimSymlinks: true`
 * to keep relative symlink targets unrewritten across hosts (Pitfall 1;
 * nodejs/node issue 41693). Exported so the test file can call it directly;
 * `remapExtrasPush` and `remapExtrasPull` are the primary public API.
 */
export function copyExtras(src: string, dst: string): void {
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true, force: true, verbatimSymlinks: true });
}

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
 * Push: copy whitelisted extras directories under each project's localRoot
 * into the repo at `shared/extras/<logical>/<dirname>/`. Returns
 * `{ unmapped, skipped }` with intentionally asymmetric granularity (see
 * `eachExtrasTarget`): `unmapped` per-project, `skipped` per-dirname; both feed
 * `emitSummary`. `opts.dryRun` logs `would push extras:` lines without writing,
 * with identical count semantics. Legacy `path-map.json` without an `extras`
 * key returns `{ unmapped: 0, skipped: 0 }` cleanly.
 */
export function remapExtrasPush(ts: string, opts: { dryRun?: boolean } = {}): ExtrasCounts {
  const dryRun = opts.dryRun === true;
  const counts: ExtrasCounts = { unmapped: 0, skipped: 0 };
  const v = loadValidatedExtras({ missingMsg: 'no path-map.json; skipping extras push' });
  if (v === null) return counts;

  const repoExtras = join(REPO_HOME, 'shared', 'extras');
  if (!dryRun) mkdirSync(repoExtras, { recursive: true });

  for (const { logical, localRoot, dirname } of eachExtrasTarget(v, counts)) {
    const src = join(localRoot, dirname);
    if (!existsSync(src)) continue;
    const dst = join(repoExtras, logical, dirname);
    if (dryRun) {
      log(`would push extras: ${src} -> ${dst}`);
      continue;
    }
    backupRepoWrite(dst, ts, REPO_HOME);
    copyExtras(src, dst);
    log(`pushed extras ${logical}/${dirname} -> shared/extras/${logical}/${dirname}`);
  }
  return counts;
}

/**
 * Pull: copy whitelisted extras from `shared/extras/<logical>/<dirname>/`
 * back into each project's localRoot on this host. Returns `{ unmapped,
 * skipped }` with the same asymmetric granularity as `remapExtrasPush`.
 * `opts.dryRun` logs `would overwrite extras:` lines without writing. Uses
 * `backupExtrasWrite` (not `backupBeforeWrite`) because `<localRoot>/<dirname>`
 * lives outside `CLAUDE_HOME` and the standard helper's relative-path guard
 * would no-op and lose prior content. Legacy `path-map.json` without an
 * `extras` key, or a missing `shared/extras/`, both produce a clean no-op.
 */
export function remapExtrasPull(ts: string, opts: { dryRun?: boolean } = {}): ExtrasCounts {
  const dryRun = opts.dryRun === true;
  const counts: ExtrasCounts = { unmapped: 0, skipped: 0 };
  const v = loadValidatedExtras({
    requireRepoExtras: true,
    missingMsg: 'no path-map or repo extras dir; skipping extras remap',
  });
  if (v === null) return counts;

  const repoExtras = join(REPO_HOME, 'shared', 'extras');

  for (const { logical, localRoot, dirname } of eachExtrasTarget(v, counts)) {
    const src = join(repoExtras, logical, dirname);
    if (!existsSync(src)) continue;
    const dst = join(localRoot, dirname);
    if (dryRun) {
      log(`would overwrite extras: ${dst} (from ${src})`);
      continue;
    }
    // Snapshot the host-side dst BEFORE copyExtras clobbers it. Anchor
    // on localRoot so the backup tree mirrors the project layout.
    backupExtrasWrite(dst, ts, localRoot);
    copyExtras(src, dst);
    log(`pulled extras ${logical}/${dirname} -> ${dst}`);
  }
  return counts;
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
