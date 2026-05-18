import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  CLAUDE_HOME,
  HOST,
  KNOWN_SETTINGS_KEYS,
  NEVER_SYNC,
  PUSH_ALLOWED_STATIC,
  REPO_HOME,
  SHARED_LINKS,
  type PathMap,
} from './config.ts';
import { applySharedLinks, regenerateSettings } from './links.ts';
import { remapPull, remapPush } from './remap.ts';
import { resumeCmd } from './resume.ts';
import {
  acquireLock,
  die,
  encodePath,
  freshBackupTs,
  gitStatusPorcelainZ,
  log,
  NomadFatal,
  readJson,
  releaseLock,
} from './utils.ts';

// resume sidecar lives in src/resume.ts; re-exported so callers keep importing it from ./commands.ts.
export { resumeCmd };

/**
 * Match `path` against an entry in the push allow-list. Exact match for
 * non-`/`-terminated entries; prefix match for `/`-terminated entries; and
 * a special case for `hosts/`: only `hosts/<name>.json` (single-level,
 * `.json` extension) is allowed, so arbitrary credentials like
 * `hosts/dell-wsl.key` are rejected even though they share the prefix.
 */
function isAllowed(path: string, allowed: readonly string[]): boolean {
  for (const entry of allowed) {
    if (path === entry) return true;
    if (entry === 'hosts/') {
      if (/^hosts\/[^/]+\.json$/.test(path)) return true;
      continue;
    }
    if (entry.endsWith('/') && path.startsWith(entry)) return true;
  }
  return false;
}

/** True when any path segment matches a `NEVER_SYNC` entry (hard-block list). */
function isNeverSync(path: string): boolean {
  for (const segment of path.split('/')) {
    if (NEVER_SYNC.has(segment)) return true;
  }
  return false;
}

/**
 * Parse `git status --porcelain=v1 -z` (NUL-delimited) output into a flat
 * list of paths. Handles rename (`R`) and copy (`C`) records, which span
 * two NUL fields (`XY new\0old\0`): both halves are returned so the
 * allow-list can reject either side. `-z` avoids the quoting that LF
 * porcelain applies to paths containing spaces or specials, which would
 * otherwise cause parser misclassification.
 */
export function parsePorcelainZ(statusPorcelain: string): string[] {
  const records = statusPorcelain.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec === undefined || rec === '') continue;
    // Each record starts with "XY " (2 status chars + 1 space). The path is
    // everything after byte 3. For R/C the NEXT record holds the old path.
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const newPath = rec.slice(3);
    paths.push(newPath);
    if (xy.startsWith('R') || xy.startsWith('C')) {
      const oldPath = records[i + 1];
      if (oldPath !== undefined && oldPath !== '') paths.push(oldPath);
      i++; // consume the paired old-path record
    }
  }
  return paths;
}

export function enforceAllowList(statusPorcelain: string, map: PathMap): void {
  const allowed = [
    ...PUSH_ALLOWED_STATIC,
    ...Object.keys(map.projects).map((l) => `shared/projects/${l}/`),
  ];
  const neverSyncHits: string[] = [];
  const violations: string[] = [];
  for (const path of parsePorcelainZ(statusPorcelain)) {
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
  throw new NomadFatal('push allow-list violations');
}

export function cmdPull(): void {
  if (!existsSync(REPO_HOME)) die(`repo not cloned at ${REPO_HOME}`);
  const handle = acquireLock('pull');
  if (handle === null) process.exit(0);
  try {
    // Collision-resistant ts: nowTimestamp() is second-resolution, so two
    // pulls in the same wall-clock second would share `ts` and the second's
    // backupBeforeWrite calls (cpSync force:false) would silently no-op.
    const backupBase = join(process.env.HOME ?? '', '.cache', 'claude-nomad', 'backup');
    const ts = freshBackupTs(backupBase);
    // Fail-fast: create backup root BEFORE any mutation. If mkdir fails
    // (out of disk, permission denied), die() throws (NomadFatal) and the
    // outer catch logs + sets exitCode, then finally releases the lock.
    const backupRoot = join(backupBase, ts);
    try {
      mkdirSync(backupRoot, { recursive: true });
    } catch (err) {
      die(`could not create backup dir: ${(err as Error).message}`);
    }
    log(`pulling on host=${HOST} (backup=${ts})`);
    execFileSync('git', ['pull', '--rebase', '--autostash'], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    applySharedLinks(ts);
    regenerateSettings(ts);
    remapPull(ts);
    log('pull complete');
  } catch (err) {
    // Catch fatal errors here so the finally block runs and releases the
    // lock. Throwing through process.exit() would skip finally.
    if (err instanceof NomadFatal) {
      console.error(`[nomad] FATAL: ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
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
    // Pass a collision-resistant ts down to remapPush so it can snapshot
    // repo-side encoded-dir state before copyDir clobbers it.
    const backupBase = join(process.env.HOME ?? '', '.cache', 'claude-nomad', 'backup');
    const ts = freshBackupTs(backupBase);
    remapPush(ts);
    // Routed through the shell-free, untrimmed helper. `sh` would .trim() the
    // first record's leading status-space and shift parsePorcelainZ's offsets.
    const status = gitStatusPorcelainZ(REPO_HOME);
    if (!status) {
      log('nothing to commit');
      return;
    }
    const mapPath = join(REPO_HOME, 'path-map.json');
    if (!existsSync(mapPath)) die('path-map.json missing, cannot enforce push allow-list');
    // Route a malformed path-map.json through the NomadFatal flow so the
    // finally block releases the lock; a raw SyntaxError would skip cleanup.
    let map: PathMap;
    try {
      map = readJson<PathMap>(mapPath);
    } catch (err) {
      throw new NomadFatal(`could not parse path-map.json: ${(err as Error).message}`);
    }
    enforceAllowList(status, map);
    // Use execFileSync (no implicit shell) so a NOMAD_HOST containing a
    // double-quote or backtick can't escape the commit-message quoting.
    // Same reasoning for `git add -A` and `git push` (no interpolation, but
    // shell-free is consistent and audit-friendly).
    execFileSync('git', ['add', '-A'], { cwd: REPO_HOME, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', `chore: sync from ${HOST}`], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['push'], { cwd: REPO_HOME, stdio: ['ignore', 'pipe', 'pipe'] });
    log('push complete');
  } catch (err) {
    if (err instanceof NomadFatal) {
      console.error(`[nomad] FATAL: ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    releaseLock(handle);
  }
}

/**
 * Tolerant JSON reader for `cmdDoctor`. Doctor reads three JSON files
 * (`settings.json`, `settings.base.json`, `path-map.json`) and any
 * malformed input must not throw an uncaught `SyntaxError` mid-output;
 * users would otherwise get a stack trace instead of a FAIL line and the
 * remainder of the diagnostic would never run. Returns `null` on parse
 * failure, logs the FAIL line on the same stream as the rest of doctor's
 * output (stdout, so `2>/dev/null` does not swallow failure detail), and
 * sets `process.exitCode = 1` so scripts can gate on the result.
 */
function readJsonSafe<T>(path: string, label: string): T | null {
  try {
    return readJson<T>(path);
  } catch (err) {
    log(`FAIL ${label} malformed JSON: ${(err as Error).message}`);
    process.exitCode = 1;
    return null;
  }
}

/**
 * Read-only health check for the nomad install on the current host. Reports
 * host identity, repo presence, shared-link health, settings.json schema
 * sanity, host-override status, path-map collisions, and the never-sync
 * list.
 *
 * Doctor intentionally emits ALL diagnostics (PASS/WARN/FAIL) on stdout via
 * `log()` rather than splitting WARN/FAIL to stderr. The intent is that
 * users see the full diagnostic cohesively; piping `nomad doctor 2>/dev/null`
 * must NOT lose FAIL lines. This differs from `cmdPull` / `cmdPush` /
 * `resumeCmd`, where FATAL is on stderr because those callers want clean
 * stdout. Doctor signals failure to scripts via `process.exitCode` instead.
 */
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

  // Preemptively report missing shared/settings.base.json since pull would
  // die() on it anyway. Doctor is the read-only path so it's the appropriate
  // place to surface the gap.
  const basePath = join(REPO_HOME, 'shared', 'settings.base.json');
  if (!existsSync(basePath)) {
    log(`FAIL shared/settings.base.json missing at ${basePath}`);
    process.exitCode = 1;
  }

  // Scan settings.json top-level keys against the schema baseline. WARN
  // surfaces Anthropic-added keys we have not catalogued yet. Informational
  // only; no exitCode effect because unknown keys are forward-compatible by
  // default and we do not want to break sync on every Anthropic release.
  const settingsPath = join(CLAUDE_HOME, 'settings.json');
  let settings: Record<string, unknown> | null = null;
  if (existsSync(settingsPath)) {
    settings = readJsonSafe<Record<string, unknown>>(settingsPath, settingsPath);
    if (settings !== null) {
      const unknownKeys = Object.keys(settings).filter((k) => !KNOWN_SETTINGS_KEYS.has(k));
      if (unknownKeys.length > 0) {
        log(`WARN settings.json has unknown keys (schema drift?): ${unknownKeys.join(', ')}`);
      } else {
        log('settings.json schema: known keys only');
      }
    }
  }

  // Host-override-missing FAIL: complements the pull-side WARN in
  // src/links.ts. Uses process.exitCode (NOT process.exit) so doctor's
  // remaining output continues to print after the diagnostic line.
  const hostFile = join(REPO_HOME, 'hosts', `${HOST}.json`);
  let drift: string[] = [];
  if (existsSync(basePath) && settings !== null) {
    const base = readJsonSafe<Record<string, unknown>>(basePath, basePath);
    if (base !== null) {
      const baseKeys = new Set(Object.keys(base));
      drift = Object.keys(settings).filter((k) => !baseKeys.has(k));
    }
  }
  if (existsSync(hostFile)) {
    log(`host overrides: ${hostFile}`);
  } else if (drift.length > 0) {
    log(`FAIL no hosts/${HOST}.json AND settings.json has unbased keys ${JSON.stringify(drift)}`);
    const hostsDir = join(REPO_HOME, 'hosts');
    if (existsSync(hostsDir)) {
      const cands = readdirSync(hostsDir).filter((f) => f.endsWith('.json'));
      if (cands.length > 0) log(`  candidates: ${cands.join(', ')}`);
    }
    process.exitCode = 1;
  } else {
    log('host overrides: none (base-only is fine, no settings drift)');
  }

  const mapPath = join(REPO_HOME, 'path-map.json');
  if (existsSync(mapPath)) {
    const map = readJsonSafe<PathMap>(mapPath, mapPath);
    if (map !== null) {
      const mapped = Object.entries(map.projects).filter(([, hosts]) => hosts[HOST]);
      log(`mapped projects for ${HOST}: ${mapped.length}`);
      for (const [name, hosts] of mapped) log(`  ${name} -> ${hosts[HOST]}`);

      // Scan ALL hosts in path-map.json and group by encodePath result.
      // Collisions are FAIL (exitCode 1), not WARN: two real paths that
      // encode to the same directory cause silent data loss in remap, so
      // gating downstream automation on the failure is the safer default.
      const seen = new Map<string, string>();
      let collisionCount = 0;
      for (const hosts of Object.values(map.projects)) {
        for (const abspath of Object.values(hosts)) {
          if (!abspath || abspath === 'TBD') continue;
          const encoded = encodePath(abspath);
          const prior = seen.get(encoded);
          if (prior !== undefined && prior !== abspath) {
            log(`FAIL path-encoding collision: ${prior} and ${abspath} both encode to ${encoded}`);
            collisionCount++;
          } else {
            seen.set(encoded, abspath);
          }
        }
      }
      if (collisionCount > 0) process.exitCode = 1;
    }
  } else {
    log('path-map.json: missing');
  }

  log(`never-sync items: ${[...NEVER_SYNC].join(', ')}`);
}
