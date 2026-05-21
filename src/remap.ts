import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { CLAUDE_HOME, HOST, REPO_HOME, type PathMap } from './config.ts';
import { backupBeforeWrite, backupRepoWrite, encodePath, log, readJson } from './utils.ts';

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
 * and produce one `[nomad] skip <rel>: extension not in allowlist` log
 * line each. The filter must allow the source root explicitly (Pitfall 1:
 * cpSync invokes the filter on src === src first, and a false return
 * there would abort the whole copy). Used by remapPush only; remapPull
 * keeps the unfiltered copyDir because the repo side is already curated
 * by the push gate.
 */
function copyDirJsonlOnly(src: string, dst: string): void {
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
 * Returns `{ unmapped: N }` where `N` counts path-map entries skipped for
 * this host (either `'TBD'` placeholder or no entry for `HOST`). The count
 * is consumed by `computePreview` and the future summary line.
 *
 * `opts.dryRun` (default `false`): when `true`, log `would overwrite:` lines
 * instead of calling `backupBeforeWrite` + `copyDir`. The unmapped count is
 * computed identically in both modes.
 */
export function remapPull(ts: string, opts: { dryRun?: boolean } = {}): { unmapped: number } {
  const dryRun = opts.dryRun === true;
  let unmapped = 0;
  const mapPath = join(REPO_HOME, 'path-map.json');
  const repoProjects = join(REPO_HOME, 'shared', 'projects');
  if (!existsSync(mapPath) || !existsSync(repoProjects)) {
    log('no path-map or repo projects dir; skipping session remap');
    return { unmapped: 0 };
  }

  const map = readJson<PathMap>(mapPath);
  const localProjects = join(CLAUDE_HOME, 'projects');
  if (!dryRun) mkdirSync(localProjects, { recursive: true });

  for (const [logical, hosts] of Object.entries(map.projects)) {
    const localPath = hosts[HOST];
    if (localPath === 'TBD') {
      unmapped++;
      log(`skip ${logical}: placeholder path for ${HOST}`);
      continue;
    }
    if (!localPath) {
      unmapped++;
      log(`skip ${logical}: no path for ${HOST}`);
      continue;
    }
    const src = join(repoProjects, logical);
    if (!existsSync(src)) continue;
    const dst = join(localProjects, encodePath(localPath));
    if (dryRun) {
      log(`would overwrite: ${dst} (from ${src})`);
      continue;
    }
    // Snapshot prior encoded-path-dir state BEFORE copyDir overwrites it.
    backupBeforeWrite(dst, ts);
    copyDir(src, dst);
    log(`pulled ${logical} -> ${encodePath(localPath)}`);
  }
  return { unmapped };
}

/**
 * Push: copy local path-encoded dirs back to repo under logical names.
 *
 * Returns `{ unmapped: N, collisions: M }` where `unmapped` is the count of
 * `~/.claude/projects/<dir>/` entries that have no path-map reverse-lookup
 * for this host. `collisions` is reserved for a future slice's path-encoding
 * collision detection and is always `0` here.
 *
 * `opts.dryRun` (default `false`): when `true`, log `would push:` lines
 * instead of calling `backupRepoWrite` + `copyDir`. Counts are computed
 * identically in both modes.
 */
export function remapPush(
  ts: string,
  opts: { dryRun?: boolean } = {},
): { unmapped: number; collisions: number } {
  const dryRun = opts.dryRun === true;
  let unmapped = 0;
  const collisions = 0;
  const mapPath = join(REPO_HOME, 'path-map.json');
  if (!existsSync(mapPath)) {
    log('no path-map.json; skipping session export');
    return { unmapped: 0, collisions: 0 };
  }

  const map = readJson<PathMap>(mapPath);
  const localProjects = join(CLAUDE_HOME, 'projects');
  const repoProjects = join(REPO_HOME, 'shared', 'projects');
  if (!dryRun) mkdirSync(repoProjects, { recursive: true });

  const reverse = new Map<string, string>();
  for (const [logical, hosts] of Object.entries(map.projects)) {
    const p = hosts[HOST];
    if (!p || p === 'TBD') continue;
    reverse.set(encodePath(p), logical);
  }

  if (!existsSync(localProjects)) return { unmapped, collisions };
  for (const dir of readdirSync(localProjects)) {
    const logical = reverse.get(dir);
    if (!logical) {
      unmapped++;
      log(`skip ${dir}: not in path-map for ${HOST}`);
      continue;
    }
    const repoDst = join(repoProjects, logical);
    if (dryRun) {
      log(`would push: ${dir} -> ${logical}`);
      continue;
    }
    // Snapshot repo-side destination before copyDir clobbers it. Git
    // history exists only AFTER the commit step, so a corrupt or
    // path-encoding-collided local dir would otherwise have no rollback
    // path. Symmetric with remapPull's backupBeforeWrite on the local dst.
    backupRepoWrite(repoDst, ts, REPO_HOME);
    copyDirJsonlOnly(join(localProjects, dir), repoDst);
    log(`pushed ${dir} -> ${logical}`);
  }
  return { unmapped, collisions };
}
