import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  CLAUDE_HOME,
  HOST,
  NEVER_SYNC,
  PUSH_ALLOWED_STATIC,
  REPO_HOME,
  SHARED_LINKS,
  type PathMap,
} from './config.ts';
import { applySharedLinks, regenerateSettings } from './links.ts';
import { remapPull, remapPush } from './remap.ts';
import { acquireLock, die, log, nowTimestamp, readJson, releaseLock, sh } from './utils.ts';

function isAllowed(path: string, allowed: readonly string[]): boolean {
  for (const entry of allowed) {
    if (path === entry) return true;
    if (entry.endsWith('/') && path.startsWith(entry)) return true;
  }
  return false;
}

function isNeverSync(path: string): boolean {
  for (const segment of path.split('/')) {
    if (NEVER_SYNC.has(segment)) return true;
  }
  return false;
}

// D-14/D-15/D-16: parse `git status --porcelain` output, classify each path
// against PUSH_ALLOWED_STATIC plus runtime data-driven shared/projects/<logical>/
// entries, and refuse the whole push if anything is in NEVER_SYNC or not in the
// allow-list. Whole-push refusal (no per-file skipping) per D-15.
export function enforceAllowList(statusPorcelain: string, map: PathMap): void {
  const allowed = [
    ...PUSH_ALLOWED_STATIC,
    ...Object.keys(map.projects).map((l) => `shared/projects/${l}/`),
  ];
  const neverSyncHits: string[] = [];
  const violations: string[] = [];
  for (const rawLine of statusPorcelain.split('\n')) {
    if (!rawLine) continue;
    // porcelain v1: 2 status chars + 1 space + path.
    const path = rawLine.slice(3).trim();
    if (!path) continue;
    if (isNeverSync(path)) {
      neverSyncHits.push(path);
    } else if (!isAllowed(path, allowed)) {
      violations.push(path);
    }
  }
  if (neverSyncHits.length === 0 && violations.length === 0) return;
  for (const p of neverSyncHits) {
    console.error(`[nomad] FATAL: ${p} is in NEVER_SYNC and must never be pushed`);
  }
  for (const p of violations) {
    console.error(`[nomad] FATAL: to sync ${p}, add to PUSH_ALLOWED in src/config.ts`);
  }
  process.exit(1);
}

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
    const mapPath = join(REPO_HOME, 'path-map.json');
    if (!existsSync(mapPath)) die('path-map.json missing, cannot enforce push allow-list');
    const map = readJson<PathMap>(mapPath);
    enforceAllowList(status, map);
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
