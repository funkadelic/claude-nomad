import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { HOST, REPO_HOME, SUPPORTED_EXTRAS } from './config.ts';
import { backupExtrasWrite, backupRepoWrite, log, NomadFatal, readPathMap, warn } from './utils.ts';

/**
 * `logical` keys in `path-map.json` are project identifiers (e.g. `ha-acwd`,
 * `foo`), never path fragments. A crafted key like `../escape` or `foo/bar`
 * would escape `shared/extras/` via `join()` (which normalizes `..`) and land
 * content somewhere unexpected on the filesystem. The push allow-list catches
 * such commits at the `git add` boundary, but the filesystem mutation has
 * already happened by then. This check fails fast before any write. The
 * pattern matches what every reasonable project name looks like and rejects
 * everything else; tighten only if a real project needs broader characters.
 */
const SAFE_LOGICAL = /^[A-Za-z0-9._-]+$/;
function assertSafeLogical(logical: string): void {
  if (!SAFE_LOGICAL.test(logical) || logical === '.' || logical === '..') {
    throw new NomadFatal(
      `invalid logical name in path-map.json extras: ${JSON.stringify(logical)} (must match [A-Za-z0-9._-]+; no path separators or '..')`,
    );
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
 * Push: copy whitelisted extras directories under each project's localRoot
 * into the repo at `shared/extras/<logical>/<dirname>/`. Returns
 * `{ unmapped, skipped }` where `unmapped` counts projects with no host
 * path (missing, empty, or `'TBD'`) and `skipped` counts dirnames not in
 * `SUPPORTED_EXTRAS` (whitelist enforcement); both counts feed the future
 * `emitSummary` widening. `opts.dryRun` logs `would push extras:` lines
 * without writing, with identical count semantics. Legacy `path-map.json`
 * without an `extras` key returns `{ unmapped: 0, skipped: 0 }` cleanly.
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

  const map = readPathMap(mapPath);
  const extrasMap = map.extras ?? {};
  if (Object.keys(extrasMap).length === 0) return { unmapped: 0, skipped: 0 };

  const repoExtras = join(REPO_HOME, 'shared', 'extras');
  if (!dryRun) mkdirSync(repoExtras, { recursive: true });

  const whitelist: readonly string[] = SUPPORTED_EXTRAS;

  for (const [logical, dirnames] of Object.entries(extrasMap)) {
    assertSafeLogical(logical);
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
 * Pull: copy whitelisted extras from `shared/extras/<logical>/<dirname>/`
 * back into each project's localRoot on this host. Returns `{ unmapped,
 * skipped }` symmetric with `remapExtrasPush`. `opts.dryRun` logs `would
 * overwrite extras:` lines without writing. Uses `backupExtrasWrite` (not
 * `backupBeforeWrite`) because `<localRoot>/<dirname>` lives outside
 * `CLAUDE_HOME` and the standard helper's relative-path guard would no-op
 * and lose prior content. Legacy `path-map.json` without an `extras` key,
 * or a missing `shared/extras/`, both produce a clean no-op.
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

  const map = readPathMap(mapPath);
  const extrasMap = map.extras ?? {};
  if (Object.keys(extrasMap).length === 0) return { unmapped: 0, skipped: 0 };

  const whitelist: readonly string[] = SUPPORTED_EXTRAS;

  for (const [logical, dirnames] of Object.entries(extrasMap)) {
    assertSafeLogical(logical);
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

/**
 * List files that differ between two paths via `git diff --no-index
 * --name-only`. Exit 0 = identical, exit 1 = differences exist (not an
 * error: read names from `e.stdout`). Any other status is a real git
 * failure, silently swallowed per the non-blocking contract. Argv-array
 * `execFileSync` (no shell) so paths cannot inject.
 */
function listDivergingFiles(a: string, b: string): string[] {
  try {
    const stdout = execFileSync('git', ['diff', '--no-index', '--name-only', a, b], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    return stdout.split('\n').filter((line) => line.length > 0);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number; stdout?: Buffer };
    if (e.status === 1 && e.stdout !== undefined) {
      return e.stdout
        .toString()
        .split('\n')
        .filter((line) => line.length > 0);
    }
    return [];
  }
}

/**
 * Read-only pre-pull check: compare local `<localRoot>/<dirname>/` against
 * the just-pulled `shared/extras/<logical>/<dirname>/` and emit a WARN per
 * diverging file plus a count summary. Runs AFTER `git pull --rebase` and
 * BEFORE `remapExtrasPull` (so local state is intact for comparison).
 * Non-blocking per the inherited LWW model; recovery is from
 * `~/.cache/claude-nomad/backup/<ts>/extras/` once the remap snapshots
 * host state. Silent skip on missing path-map, no `extras` key, missing
 * or `'TBD'` host path, non-whitelisted dirname, or either side absent.
 */
export function divergenceCheckExtras(): void {
  const mapPath = join(REPO_HOME, 'path-map.json');
  if (!existsSync(mapPath)) return;

  const map = readPathMap(mapPath);
  const extrasMap = map.extras ?? {};
  const whitelist: readonly string[] = SUPPORTED_EXTRAS;
  for (const [logical, dirnames] of Object.entries(extrasMap)) {
    assertSafeLogical(logical);
    const localRoot = map.projects[logical]?.[HOST];
    if (!localRoot || localRoot === 'TBD') continue;
    for (const dirname of dirnames) {
      if (!whitelist.includes(dirname)) continue;
      const local = join(localRoot, dirname);
      const repo = join(REPO_HOME, 'shared', 'extras', logical, dirname);
      if (!existsSync(local) || !existsSync(repo)) continue;
      const diff = listDivergingFiles(local, repo);
      if (diff.length > 0) {
        warn(
          `local ${dirname} for ${logical} diverges from origin in ${diff.length} file(s); next remapExtrasPull will overwrite them (backups at ~/.cache/claude-nomad/backup/<ts>/extras/)`,
        );
        for (const f of diff) warn(`  ${f}`);
      }
    }
  }
}
