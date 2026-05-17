import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_HOME, HOST, NEVER_SYNC, REPO_HOME, SHARED_LINKS, type PathMap } from './config.ts';
import { applySharedLinks, regenerateSettings } from './links.ts';
import { remapPull, remapPush } from './remap.ts';
import { acquireLock, die, log, nowTimestamp, readJson, releaseLock, sh } from './utils.ts';

export function cmdPull(): void {
  if (!existsSync(REPO_HOME)) die(`repo not cloned at ${REPO_HOME}`);
  const handle = acquireLock('pull');
  if (handle === null) process.exit(0);
  try {
    const ts = nowTimestamp();
    // D-03 fail-fast: create backup root BEFORE any mutation. If mkdir fails
    // (out of disk, permission denied), die() aborts before git pull / symlink
    // / remap, and the outer finally still releases the lock.
    const backupRoot = join(process.env.HOME ?? '', '.cache', 'claude-nomad', 'backup', ts);
    try {
      mkdirSync(backupRoot, { recursive: true });
    } catch (err) {
      die(`could not create backup dir: ${(err as Error).message}`);
    }
    log(`pulling on host=${HOST} (backup=${ts})`);
    sh('git pull --rebase', REPO_HOME);
    applySharedLinks(ts);
    regenerateSettings(ts);
    remapPull(ts);
    log('pull complete');
  } finally {
    releaseLock(handle);
  }
}

export function cmdPush(): void {
  if (!existsSync(REPO_HOME)) die(`repo not cloned at ${REPO_HOME}`);
  const handle = acquireLock('push');
  if (handle === null) process.exit(0);
  try {
    log(`pushing on host=${HOST}`);
    remapPush();
    const status = sh('git status --porcelain', REPO_HOME);
    if (!status) {
      log('nothing to commit');
      return;
    }
    sh('git add -A', REPO_HOME);
    sh(`git commit -m "chore: sync from ${HOST}"`, REPO_HOME);
    sh('git push', REPO_HOME);
    log('push complete');
  } finally {
    releaseLock(handle);
  }
}

export function cmdDoctor(): void {
  log(`host: ${HOST}`);
  log(`repo: ${REPO_HOME} ${existsSync(REPO_HOME) ? 'OK' : 'MISSING'}`);
  log(`claude home: ${CLAUDE_HOME} ${existsSync(CLAUDE_HOME) ? 'OK' : 'MISSING'}`);

  for (const name of SHARED_LINKS) {
    const p = join(CLAUDE_HOME, name);
    if (!existsSync(p)) {
      log(`  ${name}: missing`);
      continue;
    }
    log(
      `  ${name}: ${lstatSync(p).isSymbolicLink() ? 'symlink OK' : 'NOT a symlink (blocks sync)'}`,
    );
  }

  const hostFile = join(REPO_HOME, 'hosts', `${HOST}.json`);
  log(`host overrides: ${existsSync(hostFile) ? hostFile : 'none'}`);

  const mapPath = join(REPO_HOME, 'path-map.json');
  if (existsSync(mapPath)) {
    const map = readJson<PathMap>(mapPath);
    const mapped = Object.entries(map.projects).filter(([, hosts]) => hosts[HOST]);
    log(`mapped projects for ${HOST}: ${mapped.length}`);
    for (const [name, hosts] of mapped) log(`  ${name} -> ${hosts[HOST]}`);
  } else {
    log('path-map.json: missing');
  }

  log(`never-sync items: ${[...NEVER_SYNC].join(', ')}`);
}
