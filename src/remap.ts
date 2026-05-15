import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_HOME, HOST, REPO_HOME, type PathMap } from './config.ts';
import { encodePath, log, readJson } from './utils.ts';

function copyDir(src: string, dst: string): void {
  cpSync(src, dst, { recursive: true, force: true });
}

/** Pull: copy from repo's logical project names into local path-encoded dirs. */
export function remapPull(): void {
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
    copyDir(src, join(localProjects, encodePath(localPath)));
    log(`pulled ${logical} -> ${encodePath(localPath)}`);
  }
}

/** Push: copy local path-encoded dirs back to repo under logical names. */
export function remapPush(): void {
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
    if (p) reverse.set(encodePath(p), logical);
  }

  if (!existsSync(localProjects)) return;
  for (const dir of readdirSync(localProjects)) {
    const logical = reverse.get(dir);
    if (!logical) {
      log(`skip ${dir}: not in path-map for ${HOST}`);
      continue;
    }
    copyDir(join(localProjects, dir), join(repoProjects, logical));
    log(`pushed ${dir} -> ${logical}`);
  }
}
