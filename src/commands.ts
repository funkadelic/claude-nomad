import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { blue, cyan, dim, green, red, yellow } from './color.ts';
import {
  CLAUDE_HOME,
  HOME,
  HOST,
  KNOWN_SETTINGS_KEYS,
  NEVER_SYNC,
  PUSH_ALLOWED_STATIC,
  REPO_HOME,
  SHARED_LINKS,
  type PathMap,
} from './config.ts';
import { applySharedLinks, regenerateSettings } from './links.ts';
import { findGitlinks, probeGitleaks, rebaseBeforePush, runGitleaksScan } from './push-checks.ts';
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
 * Run `git <args>` in REPO_HOME, forwarding stderr and converting non-zero
 * exits to NomadFatal. Without this wrap, an ExecException would bubble past
 * the cmdPull/cmdPush NomadFatal-only catch blocks and surface as a stack
 * trace; the finally still releases the lock, but the user UX degrades.
 */
function gitOrFatal(args: readonly string[], context: string): void {
  try {
    execFileSync('git', args, { cwd: REPO_HOME, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as Error & { stderr?: Buffer };
    if (e.stderr) process.stderr.write(e.stderr);
    throw new NomadFatal(`${context} failed`);
  }
}

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

/**
 * Reject any staged path that is not on the push allow-list or that matches a
 * `NEVER_SYNC` entry. Builds the runtime allow-list by combining
 * `PUSH_ALLOWED_STATIC` with one `shared/projects/<logical>/` prefix per entry
 * in `path-map.json`. Logs every violation as a FATAL line so the user sees
 * the full set (not just the first), then throws `NomadFatal` to unwind the
 * caller's try/finally and release the push lock.
 */
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

/**
 * `nomad pull` command. Acquires the push/pull lock, takes a backup
 * timestamp, runs `git pull --rebase --autostash` in `REPO_HOME`, then
 * applies the three side-effecting sync steps in order:
 *   1. `applySharedLinks` (symlink shared/* into ~/.claude/)
 *   2. `regenerateSettings` (deep-merge base + host-override into settings.json)
 *   3. `remapPull` (copy repo-side session transcripts into host-encoded dirs)
 *
 * Any `NomadFatal` thrown along the way is caught here so the `finally` block
 * releases the lock before exit (a raw `process.exit()` would skip `finally`
 * and leak the lock — see `NomadFatal` JSDoc). Non-fatal errors rethrow.
 */
export function cmdPull(): void {
  if (!existsSync(REPO_HOME)) die(`repo not cloned at ${REPO_HOME}`);
  const handle = acquireLock('pull');
  if (handle === null) process.exit(0);
  try {
    // Collision-resistant ts: nowTimestamp() is second-resolution, so two
    // pulls in the same wall-clock second would share `ts` and the second's
    // backupBeforeWrite calls (cpSync force:false) would silently no-op.
    const backupBase = join(HOME, '.cache', 'claude-nomad', 'backup');
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
    gitOrFatal(['pull', '--rebase', '--autostash'], 'git pull --rebase');
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

/**
 * `nomad push` command. Acquires the lock, runs the four pre-push safety
 * checks in the order from CONTEXT.md, stages, and pushes:
 *   1. `probeGitleaks` (fail fast if the secret scanner isn't on PATH)
 *   2. `rebaseBeforePush` (surface remote conflicts against committed state,
 *      not against in-flight `remapPush` copies)
 *   3. `remapPush` (copy host-encoded session dirs into shared logical names)
 *   4. `findGitlinks` walk of `shared/` (refuse to push nested .git entries;
 *      runs AFTER `remapPush` so it catches .git dirs copied in from the host)
 *   5. allow-list enforcement on the resulting `git status` (refuse any path
 *      not on `PUSH_ALLOWED_STATIC` or matching `NEVER_SYNC`)
 *   6. `git add -A` → `runGitleaksScan` on staged tree → `git commit` → `git push`
 *
 * The gitleaks scan runs AFTER staging so it sees what would actually be
 * pushed, but BEFORE commit so a detection unwinds cleanly without leaving a
 * commit to amend or revert. Any `NomadFatal` is caught here so `finally`
 * releases the lock.
 */
export function cmdPush(): void {
  if (!existsSync(REPO_HOME)) die(`repo not cloned at ${REPO_HOME}`);
  const handle = acquireLock('push');
  if (handle === null) process.exit(0);
  try {
    log(`pushing on host=${HOST}`);
    // Gitleaks presence probe at the top of the flow. Fail fast if missing
    // so the remaining steps don't waste time mutating local state.
    probeGitleaks();
    // Rebase BEFORE any local mutation. Surfaces remote conflicts against
    // the user's committed state, not against in-flight remapPush copies.
    // NomadFatal here unwinds via the existing finally.
    rebaseBeforePush();
    // Pass a collision-resistant ts down to remapPush so it can snapshot
    // repo-side encoded-dir state before copyDir clobbers it.
    const backupBase = join(HOME, '.cache', 'claude-nomad', 'backup');
    const ts = freshBackupTs(backupBase);
    // remapPush runs BEFORE the empty-status check below: it produces the
    // diffs that status observes, so swapping the order would short-circuit
    // before anything is staged.
    remapPush(ts);
    // Gitlink walk of shared/ AFTER remapPush so it inspects the post-copy
    // tree. A nested .git inside a host's ~/.claude/projects/<encoded>/ dir
    // (rare but possible — manual git init, accidental clone) would be
    // copied into shared/projects/<logical>/ by remapPush and slip past a
    // pre-remap scan; the allow-list prefix-matches everything under
    // shared/projects/<logical>/, so the gitlink would otherwise reach the
    // remote. Per-hit FATAL on stderr plus a single summarizing throw,
    // mirroring enforceAllowList. findGitlinks tolerates a missing dir
    // (returns []), so this is a no-op on a freshly-initialized repo.
    const sharedDir = join(REPO_HOME, 'shared');
    const gitlinks = findGitlinks(sharedDir);
    if (gitlinks.length > 0) {
      for (const p of gitlinks) {
        const rel = relative(REPO_HOME, p);
        console.error(
          `[nomad] FATAL: gitlink: ${rel} would push as submodule (run: rm -rf ${rel} or remove the nested repo)`,
        );
      }
      throw new NomadFatal(
        `gitlink trap: ${gitlinks.length} nested .git ${gitlinks.length === 1 ? 'entry' : 'entries'} in shared/; remove before retry`,
      );
    }
    // Routed through the shell-free, untrimmed helper because `sh` would
    // .trim() the first record's leading status-space and shift
    // parsePorcelainZ's offsets.
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
    // gitOrFatal uses execFileSync (no implicit shell) so a NOMAD_HOST
    // containing a double-quote or backtick can't escape the commit-message
    // quoting. Non-zero exits surface as NomadFatal with forwarded stderr.
    gitOrFatal(['add', '-A'], 'git add');
    // Gitleaks scan AFTER staging, BEFORE commit. The empty-status early
    // return above guarantees we only reach here when something is staged
    // (scanning an empty index would produce a confusing no-op success).
    runGitleaksScan();
    gitOrFatal(['commit', '-m', `chore: sync from ${HOST}`], 'git commit');
    gitOrFatal(['push'], 'git push');
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
  log(`host: ${cyan(HOST)}`);
  log(`repo: ${blue(REPO_HOME)} ${existsSync(REPO_HOME) ? green('OK') : red('MISSING')}`);
  log(
    `claude home: ${blue(CLAUDE_HOME)} ${existsSync(CLAUDE_HOME) ? green('OK') : red('MISSING')}`,
  );

  for (const name of SHARED_LINKS) {
    const p = join(CLAUDE_HOME, name);
    if (!existsSync(p)) {
      log(`  ${name}: missing`);
      continue;
    }
    log(
      `  ${name}: ${lstatSync(p).isSymbolicLink() ? green('symlink OK') : red('NOT a symlink (blocks sync)')}`,
    );
  }

  // Preemptively report missing OR malformed shared/settings.base.json (pull
  // would die() on either). Parse unconditionally when present so a fresh host
  // (no settings.json yet) still catches a broken base before the first pull.
  const basePath = join(REPO_HOME, 'shared', 'settings.base.json');
  let base: Record<string, unknown> | null = null;
  if (!existsSync(basePath)) {
    log(`${red('FAIL')} shared/settings.base.json missing at ${blue(basePath)}`);
    process.exitCode = 1;
  } else {
    base = readJsonSafe<Record<string, unknown>>(basePath, basePath);
  }

  // Scan settings.json top-level keys against the schema baseline. WARN on
  // unknown keys (forward-compatible by default; no exitCode change).
  const settingsPath = join(CLAUDE_HOME, 'settings.json');
  let settings: Record<string, unknown> | null = null;
  if (existsSync(settingsPath)) {
    settings = readJsonSafe<Record<string, unknown>>(settingsPath, settingsPath);
    if (settings !== null) {
      const unknownKeys = Object.keys(settings).filter((k) => !KNOWN_SETTINGS_KEYS.has(k));
      if (unknownKeys.length > 0) {
        log(
          `${yellow('WARN')} settings.json has unknown keys (schema drift?): ${unknownKeys.join(', ')}`,
        );
      } else {
        log('settings.json schema: known keys only');
      }
    }
  }

  // Host-override-missing FAIL (complements links.ts pull-side WARN). Drift
  // calculation only runs when both base and settings parsed successfully.
  const hostFile = join(REPO_HOME, 'hosts', `${HOST}.json`);
  let drift: string[] = [];
  if (base !== null && settings !== null) {
    const baseKeys = new Set(Object.keys(base));
    drift = Object.keys(settings).filter((k) => !baseKeys.has(k));
  }
  if (existsSync(hostFile)) {
    // Parse hostFile to surface malformed JSON before pull's deep-merge would
    // fail on it; readJsonSafe FAILs and sets exitCode=1 on parse error.
    if (readJsonSafe<Record<string, unknown>>(hostFile, hostFile) !== null) {
      log(`host overrides: ${blue(hostFile)}`);
    }
  } else if (drift.length > 0) {
    log(
      `${red('FAIL')} no hosts/${HOST}.json AND settings.json has unbased keys ${JSON.stringify(drift)}`,
    );
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
      log(`mapped projects for ${cyan(HOST)}: ${dim(String(mapped.length))}`);
      for (const [name, hosts] of mapped) log(`  ${name} -> ${blue(hosts[HOST])}`);

      // Encode-collision scan across all hosts; FAIL because remap data loss is silent.
      const seen = new Map<string, string>();
      let collisionCount = 0;
      for (const hosts of Object.values(map.projects)) {
        for (const abspath of Object.values(hosts)) {
          if (!abspath || abspath === 'TBD') continue;
          const encoded = encodePath(abspath);
          const prior = seen.get(encoded);
          if (prior !== undefined && prior !== abspath) {
            log(
              `${red('FAIL')} path-encoding collision: ${prior} and ${abspath} both encode to ${encoded}`,
            );
            collisionCount++;
          } else {
            seen.set(encoded, abspath);
          }
        }
      }
      if (collisionCount > 0) process.exitCode = 1;
    }
  } else {
    log(`${red('FAIL')} path-map.json missing at ${blue(mapPath)}`);
    process.exitCode = 1;
  }

  log(`never-sync items: ${[...NEVER_SYNC].join(', ')}`);

  // Gitleaks presence probe (read-only; logs PASS/FAIL, never throws).
  try {
    const v = execFileSync('gitleaks', ['version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim();
    log(`gitleaks: ${dim(v)}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log(`${red('FAIL')} gitleaks: not on PATH (required for nomad push)`);
    } else {
      log(`${red('FAIL')} gitleaks: probe failed: ${(err as Error).message}`);
    }
    process.exitCode = 1;
  }

  // Gitlink scan of shared/ (read-only mirror of cmdPush's walk).
  const sharedDir = join(REPO_HOME, 'shared');
  if (existsSync(sharedDir)) {
    const gitlinks = findGitlinks(sharedDir);
    for (const p of gitlinks) {
      const rel = relative(REPO_HOME, p);
      log(
        `${red('FAIL')} gitlink: ${blue(rel)} would push as submodule (run: rm -rf ${rel} or remove the nested repo)`,
      );
    }
    if (gitlinks.length > 0) process.exitCode = 1;
  }

  // Remote URL informational (no PASS/FAIL prefix).
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
    log(`remote origin: ${cyan(url)}`);
  } catch {
    log('remote origin: not configured');
  }

  // Rebase clean-tree WARN; surfaces the autostash behavior on push.
  try {
    const status = gitStatusPorcelainZ(REPO_HOME);
    if (status.length > 0) {
      log(
        `${yellow('WARN')} ${blue('~/claude-nomad/')} has uncommitted changes (nomad push will --autostash these)`,
      );
    }
  } catch {
    // Repo missing .git is already surfaced by the repo: MISSING line above.
  }
}
