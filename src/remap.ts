import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { CLAUDE_HOME, HOST, REPO_HOME, type PathMap } from './config.ts';
import { die, log } from './utils.ts';
import { backupBeforeWrite, backupRepoWrite } from './utils.fs.ts';
import { encodePath, readJson } from './utils.json.ts';

/**
 * Recursive mirror copy: removes `dst` first, then copies `src` into it.
 * `cpSync(force:true)` overwrites matching files but does not delete
 * dst-only entries; the upfront `rmSync` makes the operation a true mirror
 * so `dst` reflects `src` exactly rather than accumulating stale files.
 */
function copyDir(src: string, dst: string): void {
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true, force: true });
}

/**
 * Push-side mirror copy: identical to copyDir except a depth-0 extension
 * filter restricts to *.jsonl files only. Subdirectory contents (subagents,
 * memory, tool-results, etc.) copy recursively with no further filtering.
 * Stray .bak / .tmp / .swp / editor backups at the source root are skipped
 * and produce one `ℹ︎ skip <rel>: extension not in allowlist` log
 * line each. The filter must allow the source root explicitly (Pitfall 1:
 * cpSync invokes the filter on src === src first, and a false return
 * there would abort the whole copy). Used by remapPush only; remapPull
 * keeps the unfiltered copyDir because the repo side is already curated
 * by the push gate.
 */
export function copyDirJsonlOnly(src: string, dst: string): void {
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, {
    recursive: true,
    force: true,
    filter: (srcPath) => {
      const rel = relative(src, srcPath);
      if (rel === '') return true;
      if (rel.split(sep).length > 1) return true;
      if (statSync(srcPath).isDirectory()) return true;
      if (srcPath.endsWith('.jsonl')) return true;
      log(`skip ${rel}: extension not in allowlist`);
      return false;
    },
  });
}

/**
 * Pull: copy from repo's logical project names into local path-encoded dirs.
 *
 * Returns `{ unmapped, pulled, wouldPull }`. `unmapped` counts path-map entries
 * skipped for this host (`'TBD'` placeholder or no entry for `HOST`); `pulled`
 * holds logical names copied (wet), `wouldPull` those that would copy under
 * `dryRun`. The arrays let cmdPull render a grouped tree; the wet path no longer
 * logs per-project `pulled X -> Y` / `skip ...` inline. The dry-run path KEEPS
 * its `would overwrite:` line because `computePreview` renders those as the
 * Projects section of `nomad diff` and the dry-run pull preview. The degenerate
 * early-return `log(...)` (not a per-project skip) is preserved.
 *
 * @param ts - backup timestamp namespace.
 * @param opts.dryRun - when `true`, collect `wouldPull` and log would-overwrite.
 */
export function remapPull(
  ts: string,
  opts: { dryRun?: boolean } = {},
): { unmapped: number; pulled: string[]; wouldPull: string[] } {
  const dryRun = opts.dryRun === true;
  let unmapped = 0;
  const pulled: string[] = [];
  const wouldPull: string[] = [];
  const mapPath = join(REPO_HOME, 'path-map.json');
  const repoProjects = join(REPO_HOME, 'shared', 'projects');
  if (!existsSync(mapPath) || !existsSync(repoProjects)) {
    log('no path-map or repo projects dir; skipping session remap');
    return { unmapped: 0, pulled, wouldPull };
  }

  const map = readJson<PathMap>(mapPath);
  const localProjects = join(CLAUDE_HOME, 'projects');
  if (!dryRun) mkdirSync(localProjects, { recursive: true });

  for (const [logical, hosts] of Object.entries(map.projects)) {
    const localPath = hosts[HOST];
    if (!localPath || localPath === 'TBD') {
      unmapped++;
      continue;
    }
    const src = join(repoProjects, logical);
    if (!existsSync(src)) continue;
    const dst = join(localProjects, encodePath(localPath));
    if (dryRun) {
      // KEEP this would-overwrite log: computePreview (backing both `nomad
      // diff` and the dry-run pull preview) renders these lines as its
      // Projects section, so removing them regresses that output. The grouped
      // tree is built only on the WET path, which consumes `pulled` instead.
      wouldPull.push(logical);
      log(`would overwrite: ${dst} (from ${src})`);
      continue;
    }
    // Snapshot prior encoded-path-dir state BEFORE copyDir overwrites it.
    backupBeforeWrite(dst, ts);
    copyDir(src, dst);
    pulled.push(logical);
  }
  return { unmapped, pulled, wouldPull };
}

/**
 * Build the encoded-key to logical-name reverse map for the current host,
 * failing closed on any `path-map.json` shape that would silently lose session
 * data on push. Both failure modes `die()` (throw `NomadFatal`) before the
 * caller writes anything:
 *
 * - Encoded-path collision: two distinct host paths that `encodePath` maps to
 *   the same key (every `/` becomes `-`), which would clobber each other under
 *   one repo directory.
 * - Duplicate path: two logical names mapping to the same host path, where only
 *   one logical could be pushed and the other's `shared/projects/` copy would
 *   be orphaned.
 *
 * @param map - the parsed `path-map.json`
 * @returns reverse lookup from encoded local dir name to logical project name
 */
function buildReverseMap(map: PathMap): Map<string, string> {
  const reverse = new Map<string, string>();
  const encodedPaths = new Map<string, string>();
  for (const [logical, hosts] of Object.entries(map.projects)) {
    const p = hosts[HOST];
    if (!p || p === 'TBD') continue;
    const encoded = encodePath(p);
    const prior = encodedPaths.get(encoded);
    if (prior !== undefined) {
      if (prior !== p) {
        die(
          `encoded-path collision in path-map.json: "${prior}" and "${p}" both encode to` +
            ` "${encoded}" (encodePath replaces every / with -).` +
            ` Edit path-map.json so the two paths do not encode identically.` +
            ` Run nomad doctor for the full list of collisions.`,
        );
      }
      die(
        `duplicate path in path-map.json: logical names "${reverse.get(encoded)}" and "${logical}"` +
          ` both map to "${p}" for ${HOST}, so only one could be pushed and the other's` +
          ` shared/projects/ copy would be orphaned.` +
          ` Edit path-map.json so each host path maps to a single logical name.`,
      );
    }
    encodedPaths.set(encoded, p);
    reverse.set(encoded, logical);
  }
  return reverse;
}

/**
 * Push: copy local path-encoded dirs back to repo under logical names.
 *
 * Returns `{ unmapped: N, collisions: M }` where `unmapped` is the count of
 * `~/.claude/projects/<dir>/` entries that have no path-map reverse-lookup
 * for this host. `collisions` is always `0` on the success path: any
 * `path-map.json` shape that would silently lose data (an encoded-path
 * collision between two distinct host paths, or two logical names mapping to
 * the same host path) makes `buildReverseMap` `die()` (throw `NomadFatal`) to
 * refuse the push before any `shared/projects/` content is written. Detection
 * runs during the reverse-map build, so it fires under `dryRun` too.
 *
 * `opts.dryRun` (default `false`): when `true`, collect `wouldPush` without
 * calling `backupRepoWrite` + `copyDir`. Collision detection runs identically
 * in both modes.
 *
 * Returns `pushed` (logical names actually copied, wet mode) and `wouldPush`
 * (logical names under `dryRun`) alongside the counts so cmdPush can render a
 * grouped tree. This function no longer logs per-project `pushed X -> Y` /
 * `skip ... not in path-map` / `would push:` lines inline; the
 * `copyDirJsonlOnly` extension-skip log is a separate file-filter concern and
 * is preserved, as are the degenerate early-return `log(...)` lines.
 *
 * @param ts - backup timestamp namespace.
 * @param opts.dryRun - when `true`, collect `wouldPush` without mutating.
 */
export function remapPush(
  ts: string,
  opts: { dryRun?: boolean } = {},
): { unmapped: number; collisions: number; pushed: string[]; wouldPush: string[] } {
  const dryRun = opts.dryRun === true;
  let unmapped = 0;
  const pushed: string[] = [];
  const wouldPush: string[] = [];
  const mapPath = join(REPO_HOME, 'path-map.json');
  if (!existsSync(mapPath)) {
    log('no path-map.json; skipping session export');
    return { unmapped: 0, collisions: 0, pushed, wouldPush };
  }

  const map = readJson<PathMap>(mapPath);
  const localProjects = join(CLAUDE_HOME, 'projects');
  const repoProjects = join(REPO_HOME, 'shared', 'projects');

  const reverse = buildReverseMap(map);
  if (!existsSync(localProjects)) return { unmapped, collisions: 0, pushed, wouldPush };
  // Create the repo destination only after collision detection passes and we
  // know there is something to push, so a failing or no-op push is fully
  // side-effect-free (no empty shared/projects/ left behind).
  if (!dryRun) mkdirSync(repoProjects, { recursive: true });

  for (const dir of readdirSync(localProjects)) {
    const logical = reverse.get(dir);
    if (!logical) {
      unmapped++;
      continue;
    }
    const repoDst = join(repoProjects, logical);
    if (dryRun) {
      wouldPush.push(logical);
      continue;
    }
    // Snapshot repo-side destination before copyDir clobbers it. Git
    // history exists only AFTER the commit step, so a corrupt or
    // path-encoding-collided local dir would otherwise have no rollback
    // path. Symmetric with remapPull's backupBeforeWrite on the local dst.
    backupRepoWrite(repoDst, ts, REPO_HOME);
    copyDirJsonlOnly(join(localProjects, dir), repoDst);
    pushed.push(logical);
  }
  return { unmapped, collisions: 0, pushed, wouldPush };
}
