import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

// prettier-ignore
import { HOME, HOST, NEVER_SYNC, PUSH_ALLOWED_STATIC, REPO_HOME, type PathMap } from './config.ts';
import { findGitlinks, probeGitleaks, rebaseBeforePush, runGitleaksScan } from './push-checks.ts';
import { remapPush } from './remap.ts';
import { emitSummary } from './summary.ts';
// prettier-ignore
import { acquireLock, die, freshBackupTs, gitOrFatal, gitStatusPorcelainZ, log, NomadFatal, readJson, releaseLock } from './utils.ts';

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
    // Check BOTH XY positions: X is the index status, Y is the working-tree
    // status. Either can carry R (rename) or C (copy), and the old-path record
    // follows the new-path record in -z porcelain regardless of which column
    // detected the rename. Missing the Y-column case (e.g. ` R`) would skip
    // the consume and let the next iteration misread the old path as a new
    // record, smuggling unallowed sources past the allow-list.
    if (/[RC]/.test(xy)) {
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
 *   6. `git add -A` -> `runGitleaksScan` on staged tree -> `git commit` -> `git push`
 *
 * The gitleaks scan runs AFTER staging so it sees what would actually be
 * pushed, but BEFORE commit so a detection unwinds cleanly without leaving a
 * commit to amend or revert. Any `NomadFatal` is caught here so `finally`
 * releases the lock.
 *
 * `opts.dryRun` (default `false`): when `true`, the network round-trip
 * (`rebaseBeforePush`) still runs so users see what a real push would see,
 * but `remapPush` runs with `dryRun: true` (no session copies into shared/),
 * and the `git add` / `runGitleaksScan` / `git commit` / `git push` quartet
 * is skipped. The allow-list check still classifies the existing `git
 * status` so a pre-existing violation surfaces before the user thinks
 * everything is fine. Mirrors `cmdPull`'s `dryRun` contract.
 */
export function cmdPush(opts: { dryRun?: boolean } = {}): void {
  const dryRun = opts.dryRun === true;
  if (!existsSync(REPO_HOME)) die(`repo not cloned at ${REPO_HOME}`);
  const handle = acquireLock('push');
  if (handle === null) process.exit(0);
  try {
    log(dryRun ? `pushing on host=${HOST} (dry-run)` : `pushing on host=${HOST}`);
    // Probe at top of flow: fail fast if gitleaks is missing, before any mutation.
    probeGitleaks();
    // Rebase BEFORE any local mutation: surfaces remote conflicts against the
    // user's committed state, not against in-flight remapPush copies. Runs
    // under dryRun too so the network round-trip mirrors a real push.
    rebaseBeforePush();
    // Collision-resistant ts for remapPush's pre-copy snapshot of repo-side state.
    const backupBase = join(HOME, '.cache', 'claude-nomad', 'backup');
    const ts = freshBackupTs(backupBase);
    // remapPush runs BEFORE the empty-status check: it produces the diffs status
    // observes, so swapping the order would short-circuit before anything is staged.
    const remapResult = remapPush(ts, { dryRun });
    // Gitlink walk of shared/ AFTER remapPush so it inspects the post-copy tree.
    // A nested .git copied in from a host's encoded session dir would slip past a
    // pre-remap scan and reach the remote via the shared/projects/<logical>/ prefix.
    // Per-hit FATAL on stderr plus a summarizing throw, mirroring enforceAllowList.
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
    // Routed through the shell-free, untrimmed helper because `sh` would .trim()
    // the leading status-space and shift parsePorcelainZ's offsets.
    const status = gitStatusPorcelainZ(REPO_HOME);
    if (!status) {
      log('nothing to commit');
      emitSummary('push', remapResult.unmapped, remapResult.collisions);
      return;
    }
    const mapPath = join(REPO_HOME, 'path-map.json');
    if (!existsSync(mapPath)) die('path-map.json missing, cannot enforce push allow-list');
    // Route a malformed path-map.json through NomadFatal so finally releases the lock.
    let map: PathMap;
    try {
      map = readJson<PathMap>(mapPath);
    } catch (err) {
      throw new NomadFatal(`could not parse path-map.json: ${(err as Error).message}`);
    }
    enforceAllowList(status, map);
    if (dryRun) {
      // Skip the staging quartet so no commit lands and nothing is pushed.
      // The user has already seen probeGitleaks pass, the rebase result, the
      // remap preview, the gitlink scan, and the allow-list classification.
      log('push: dry-run; skipping git add, gitleaks scan, commit, and push');
      emitSummary('push', remapResult.unmapped, remapResult.collisions);
      return;
    }
    // gitOrFatal uses execFileSync (no shell) so NOMAD_HOST cannot escape quoting.
    gitOrFatal(['add', '-A'], 'git add', REPO_HOME);
    // Gitleaks scan AFTER staging (sees what would push), BEFORE commit (no cleanup
    // needed on detection). The empty-status early return above guarantees the
    // index is non-empty here.
    runGitleaksScan();
    gitOrFatal(['commit', '-m', `chore: sync from ${HOST}`], 'git commit', REPO_HOME);
    gitOrFatal(['push'], 'git push', REPO_HOME);
    log('push complete');
    emitSummary('push', remapResult.unmapped, remapResult.collisions);
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
