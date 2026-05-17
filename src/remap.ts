import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

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

/** Pull: copy from repo's logical project names into local path-encoded dirs. */
export function remapPull(ts: string): void {
  const mapPath = join(REPO_HOME, 'path-map.json');
  const repoProjects = join(REPO_HOME, 'shared', 'projects');
  if (!existsSync(mapPath) || !existsSync(repoProjects)) {
    log('no path-map or repo projects dir; skipping session remap');
    return;
  }

  const map = readJson<PathMap>(mapPath);
  const localProjects = join(CLAUDE_HOME, 'projects');
  mkdirSync(localProjects, { recursive: true });

  for (const [logical, hosts] of Object.entries(map.projects)) {
    const localPath = hosts[HOST];
    if (localPath === 'TBD') {
      log(`skip ${logical}: placeholder path for ${HOST}`);
      continue;
    }
    if (!localPath) {
      log(`skip ${logical}: no path for ${HOST}`);
      continue;
    }
    const src = join(repoProjects, logical);
    if (!existsSync(src)) continue;
    const dst = join(localProjects, encodePath(localPath));
    // D-01: snapshot prior encoded-path-dir state BEFORE copyDir overwrites it.
    backupBeforeWrite(dst, ts);
    copyDir(src, dst);
    log(`pulled ${logical} -> ${encodePath(localPath)}`);
  }
}

/** Push: copy local path-encoded dirs back to repo under logical names. */
export function remapPush(ts: string): void {
  const mapPath = join(REPO_HOME, 'path-map.json');
  if (!existsSync(mapPath)) {
    log('no path-map.json; skipping session export');
    return;
  }

  const map = readJson<PathMap>(mapPath);
  const localProjects = join(CLAUDE_HOME, 'projects');
  const repoProjects = join(REPO_HOME, 'shared', 'projects');
  mkdirSync(repoProjects, { recursive: true });

  const reverse = new Map<string, string>();
  for (const [logical, hosts] of Object.entries(map.projects)) {
    const p = hosts[HOST];
    if (!p || p === 'TBD') continue;
    reverse.set(encodePath(p), logical);
  }

  if (!existsSync(localProjects)) return;
  for (const dir of readdirSync(localProjects)) {
    const logical = reverse.get(dir);
    if (!logical) {
      log(`skip ${dir}: not in path-map for ${HOST}`);
      continue;
    }
    const repoDst = join(repoProjects, logical);
    // WR-03: snapshot repo-side destination before copyDir clobbers it. Git
    // history exists only AFTER the commit step, so a corrupt or
    // path-encoding-collided local dir would otherwise have no rollback path.
    // Symmetric with remapPull's backupBeforeWrite on the local dst.
    backupRepoWrite(repoDst, ts, REPO_HOME);
    copyDir(join(localProjects, dir), repoDst);
    log(`pushed ${dir} -> ${logical}`);
  }
}
