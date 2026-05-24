import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

import { HOME, HOST, REPO_HOME, SUPPORTED_EXTRAS, type PathMap } from './config.ts';
// prettier-ignore
import { backupExtrasWrite, backupRepoWrite, encodePath, log, NomadFatal, readPathMap, warn } from './utils.ts';

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
 * Reject `localRoot` values that contain unnormalized segments (`..`,
 * redundant `/.`, trailing slashes that don't survive `normalize`). A
 * poisoned `path-map.json` with `host: '/tmp/x/../escape'` would silently
 * land writes at `/tmp/escape/.planning/` because `path.join` normalizes
 * `..` before `cpSync` sees the destination. The user thinks they declared
 * one path and got another. Requiring `localRoot === normalize(localRoot)`
 * (and an absolute path on top) catches the obvious traversal trick and
 * forces poisoned-map writes to surface as a FATAL before any filesystem
 * mutation. Same defense-in-depth shape as `assertSafeLogical`.
 */
function assertSafeLocalRoot(localRoot: string, logical: string): void {
  if (!isAbsolute(localRoot)) {
    throw new NomadFatal(
      `invalid localRoot for ${logical} in path-map.json: ${JSON.stringify(localRoot)} (must be absolute)`,
    );
  }
  if (localRoot !== normalize(localRoot)) {
    throw new NomadFatal(
      `invalid localRoot for ${logical} in path-map.json: ${JSON.stringify(localRoot)} (must be already-normalized; no '..' or redundant segments)`,
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
 * Repo-relative `shared/extras/<logical>/<dirname>` paths for every
 * (logical, whitelisted dirname) pair declared in `map.extras`. This is the
 * same prefix set the push allow-list permits (minus the trailing slash, so
 * the values are usable directly as `git add` arguments). Used by the fork
 * update path (issue #112) to pre-commit overlapping extras before
 * `git merge upstream/main`, turning an untracked-overwrite abort into a
 * tracked-file merge. Non-whitelisted dirnames are filtered out so manually
 * staged content under a non-supported dirname is never auto-committed.
 * Logical names are validated for path-traversal safety first, matching the
 * `remapExtras*` contract.
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
 * `{ unmapped, skipped }` with intentionally asymmetric granularity:
 * `unmapped` is per-project (one increment per `logical` with no host path,
 * which short-circuits before its dirnames are visited) and `skipped` is
 * per-dirname (one increment per non-whitelisted entry inside an otherwise
 * mapped project). Both counts feed `emitSummary`; the asymmetry mirrors
 * the underlying skip-loop control flow (outer per-logical, inner
 * per-dirname) and matches what an operator wants to see in the summary
 * line. `opts.dryRun` logs `would push extras:` lines without writing,
 * with identical count semantics. Legacy `path-map.json` without an
 * `extras` key returns `{ unmapped: 0, skipped: 0 }` cleanly.
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

  // Validation pass: FATAL on any poisoned logical or unnormalized
  // localRoot before any filesystem mutation. Runs over the entire extras
  // map up-front so the documented "FATAL before any filesystem mutation"
  // contract holds even when a clean entry sits ahead of a poisoned one in
  // the iteration order (otherwise `mkdirSync(shared/extras/)` and the
  // first cpSync would already have landed before the FATAL fired).
  for (const logical of Object.keys(extrasMap)) {
    assertSafeLogical(logical);
    const localRoot = map.projects[logical]?.[HOST];
    if (localRoot && localRoot !== 'TBD') assertSafeLocalRoot(localRoot, logical);
  }

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
 * Pull: copy whitelisted extras from `shared/extras/<logical>/<dirname>/`
 * back into each project's localRoot on this host. Returns `{ unmapped,
 * skipped }` with the same asymmetric granularity as `remapExtrasPush`:
 * `unmapped` per-project, `skipped` per-dirname. `opts.dryRun` logs `would
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

  // Validation pass: FATAL on any poisoned logical or unnormalized
  // localRoot before any host-side `backupExtrasWrite` or `copyExtras`
  // runs. Symmetric with `remapExtrasPush`: a poisoned entry anywhere in
  // the map must fail the whole pull up-front, otherwise a clean entry
  // earlier in iteration order would already have clobbered the host
  // before the FATAL fired (partial host-side mutation breaks the
  // documented "fail before mutation" contract).
  for (const logical of Object.keys(extrasMap)) {
    assertSafeLogical(logical);
    const localRoot = map.projects[logical]?.[HOST];
    if (localRoot && localRoot !== 'TBD') assertSafeLocalRoot(localRoot, logical);
  }

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

/**
 * List files that differ between two paths via `git diff --no-index
 * --name-only`. Exit 0 = identical, exit 1 = differences exist (not an
 * error: read names from `e.stdout`). Other failures are surfaced via WARN
 * so the operator can tell the difference between "no diff" (silent),
 * "git not on PATH" (WARN), and other git failures (WARN) instead of all
 * three paths collapsing to a silent empty list and defeating D-08's
 * loud-doctor contract. Argv-array `execFileSync` (no shell) so paths
 * cannot inject.
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
    if (e.code === 'ENOENT') {
      warn(`git not on PATH; divergence check skipped for ${a}`);
      return [];
    }
    warn(`divergence check failed for ${a}: ${e.message ?? String(err)}`);
    return [];
  }
}

/**
 * Read-only pre-pull check: compare local `<localRoot>/<dirname>/` against
 * the just-pulled `shared/extras/<logical>/<dirname>/` and emit a WARN per
 * diverging file plus a count summary. Runs AFTER `git pull --rebase` and
 * BEFORE `remapExtrasPull` (so local state is intact for comparison).
 * Non-blocking per the inherited LWW model; the WARN message names the
 * per-project `~/.cache/claude-nomad/backup/<ts>/extras/<encoded-localRoot>/`
 * path that `remapExtrasPull` will write to so users can recover the
 * overwritten content. The `<encoded-localRoot>` namespace mirrors
 * `backupExtrasWrite`'s layout so two opted-in projects with the same
 * relative extras path do not collide. Silent skip on missing path-map, no
 * `extras` key, missing or `'TBD'` host path, non-whitelisted dirname, or
 * either side absent.
 */
export function divergenceCheckExtras(ts: string): void {
  const mapPath = join(REPO_HOME, 'path-map.json');
  if (!existsSync(mapPath)) return;

  const map = readPathMap(mapPath);
  const extrasMap = map.extras ?? {};
  const whitelist: readonly string[] = SUPPORTED_EXTRAS;
  const backupRoot = join(HOME, '.cache', 'claude-nomad', 'backup', ts, 'extras');
  for (const [logical, dirnames] of Object.entries(extrasMap)) {
    assertSafeLogical(logical);
    const localRoot = map.projects[logical]?.[HOST];
    if (!localRoot || localRoot === 'TBD') continue;
    assertSafeLocalRoot(localRoot, logical);
    const projectBackupRoot = join(backupRoot, encodePath(localRoot));
    for (const dirname of dirnames) {
      if (!whitelist.includes(dirname)) continue;
      const local = join(localRoot, dirname);
      const repo = join(REPO_HOME, 'shared', 'extras', logical, dirname);
      if (!existsSync(local) || !existsSync(repo)) continue;
      const diff = listDivergingFiles(local, repo);
      if (diff.length > 0) {
        warn(
          `local ${dirname} for ${logical} diverges from origin in ${diff.length} file(s); next remapExtrasPull will overwrite them (backups at ${projectBackupRoot}/)`,
        );
        for (const f of diff) warn(`  ${f}`);
      }
    }
  }
}
