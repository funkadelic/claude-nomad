import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { HOST, REPO_HOME, SUPPORTED_EXTRAS, type PathMap } from './config.ts';
import { backupExtrasWrite, backupRepoWrite, log, readJson } from './utils.ts';

/**
 * Recursive mirror copy: removes `dst` first, then copies `src` into it.
 * `cpSync(force:true)` overwrites matching files but does not delete
 * dst-only entries; the upfront `rmSync` makes the operation a true mirror
 * so `dst` reflects `src` exactly rather than accumulating stale files.
 *
 * Differs from `copyDir` in `remap.ts` only by passing `verbatimSymlinks: true`
 * to `cpSync`. Without that flag, Node's default behavior rewrites relative
 * symlink targets inside the source tree to absolute paths into the source
 * host's filesystem (Pitfall 1; see nodejs/node issue 41693, fixed by the
 * flag introduced in Node 18). The repo would then carry dangling absolute
 * paths that break on every other host. The `.planning/` tree is the first
 * sync target that realistically contains symlinks, so the flag is required.
 *
 * Exported (not file-local) so the test file can call it directly;
 * `remapExtrasPush` and `remapExtrasPull` below are the primary public API.
 */
export function copyExtras(src: string, dst: string): void {
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true, force: true, verbatimSymlinks: true });
}

/**
 * Push: copy whitelisted extras directories under each project's localRoot
 * into the repo at `shared/extras/<logical>/<dirname>/`.
 *
 * Returns `{ unmapped: N, skipped: M }` where `unmapped` counts projects
 * that have an `extras` entry but no resolvable host path (missing entry,
 * empty string, or `'TBD'`), and `skipped` counts directory names that
 * appear in `extras` but are not on `SUPPORTED_EXTRAS` (D-04 whitelist
 * enforcement). The two counts are independent and consumed by the future
 * `emitSummary` widening.
 *
 * `opts.dryRun` (default `false`): when `true`, log `would push extras:`
 * lines instead of calling `backupRepoWrite` + `copyExtras`. Counts are
 * computed identically in both modes.
 *
 * Legacy `path-map.json` files without a top-level `extras` key return
 * `{ unmapped: 0, skipped: 0 }` cleanly per the D-03 additive contract.
 */
export function remapExtrasPush(
  ts: string,
  opts: { dryRun?: boolean } = {},
): { unmapped: number; skipped: number } {
  const dryRun = opts.dryRun === true;
  let unmapped = 0;
  let skipped = 0;
  const mapPath = join(REPO_HOME, 'path-map.json');
  if (!existsSync(mapPath)) {
    log('no path-map.json; skipping extras push');
    return { unmapped: 0, skipped: 0 };
  }

  const map = readJson<PathMap>(mapPath);
  const extrasMap = map.extras ?? {};
  if (Object.keys(extrasMap).length === 0) return { unmapped: 0, skipped: 0 };

  const repoExtras = join(REPO_HOME, 'shared', 'extras');
  if (!dryRun) mkdirSync(repoExtras, { recursive: true });

  const whitelist: readonly string[] = SUPPORTED_EXTRAS;

  for (const [logical, dirnames] of Object.entries(extrasMap)) {
    const localRoot = map.projects[logical]?.[HOST];
    if (!localRoot || localRoot === 'TBD') {
      unmapped++;
      log(`skip ${logical}: no path for ${HOST}`);
      continue;
    }
    for (const dirname of dirnames) {
      if (!whitelist.includes(dirname)) {
        skipped++;
        log(`skip ${dirname} for ${logical}: not in SUPPORTED_EXTRAS`);
        continue;
      }
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
  }
  return { unmapped, skipped };
}

/**
 * Pull: copy whitelisted extras directories from the repo at
 * `shared/extras/<logical>/<dirname>/` back into each project's localRoot
 * on this host.
 *
 * Returns `{ unmapped: N, skipped: M }`, symmetric with `remapExtrasPush`.
 * `opts.dryRun` (default `false`): when `true`, log `would overwrite
 * extras:` lines instead of calling `backupExtrasWrite` + `copyExtras`.
 *
 * Backs up host-side state via `backupExtrasWrite` (NOT `backupBeforeWrite`)
 * because `<localRoot>/<dirname>` lives outside `CLAUDE_HOME`; the existing
 * helper's `relative(CLAUDE_HOME, absPath)` guard would silently no-op and
 * the prior on-disk content would be lost. See `utils.ts` for the
 * `extras/`-prefixed backup root layout.
 *
 * Legacy `path-map.json` files without a top-level `extras` key, or a
 * missing `shared/extras/` directory in the repo, both produce a clean
 * `{ unmapped: 0, skipped: 0 }` no-op per the D-03 additive contract.
 */
export function remapExtrasPull(
  ts: string,
  opts: { dryRun?: boolean } = {},
): { unmapped: number; skipped: number } {
  const dryRun = opts.dryRun === true;
  let unmapped = 0;
  let skipped = 0;
  const mapPath = join(REPO_HOME, 'path-map.json');
  const repoExtras = join(REPO_HOME, 'shared', 'extras');
  if (!existsSync(mapPath) || !existsSync(repoExtras)) {
    log('no path-map or repo extras dir; skipping extras remap');
    return { unmapped: 0, skipped: 0 };
  }

  const map = readJson<PathMap>(mapPath);
  const extrasMap = map.extras ?? {};
  if (Object.keys(extrasMap).length === 0) return { unmapped: 0, skipped: 0 };

  const whitelist: readonly string[] = SUPPORTED_EXTRAS;

  for (const [logical, dirnames] of Object.entries(extrasMap)) {
    const localRoot = map.projects[logical]?.[HOST];
    if (!localRoot || localRoot === 'TBD') {
      unmapped++;
      log(`skip ${logical}: no path for ${HOST}`);
      continue;
    }
    for (const dirname of dirnames) {
      if (!whitelist.includes(dirname)) {
        skipped++;
        log(`skip ${dirname} for ${logical}: not in SUPPORTED_EXTRAS`);
        continue;
      }
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
  }
  return { unmapped, skipped };
}
