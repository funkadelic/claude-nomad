import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { HOME, HOST, REPO_HOME } from './config.ts';
import { applySharedLinks, regenerateSettings } from './links.ts';
import { computePreview } from './preview.ts';
import { remapPull } from './remap.ts';
import { emitSummary } from './summary.ts';
// prettier-ignore
import { acquireLock, die, freshBackupTs, gitOrFatal, log, NomadFatal, releaseLock } from './utils.ts';

/**
 * `nomad pull` command. Acquires the push/pull lock, takes a backup
 * timestamp, runs `git pull --rebase --autostash` in `REPO_HOME`, then
 * applies the three side-effecting sync steps in order:
 *   1. `applySharedLinks` (symlink shared/* into ~/.claude/)
 *   2. `regenerateSettings` (deep-merge base + host-override into settings.json)
 *   3. `remapPull` (copy repo-side session transcripts into host-encoded dirs)
 *
 * `opts.dryRun` (default `false`): when `true`, the lock IS still acquired
 * and `git pull --rebase` still runs (so concurrent invocations cannot race
 * and so the user sees the same network round-trip behavior they would on a
 * real pull). Then `computePreview` runs in place of the three mutating
 * steps. The per-run backup directory under
 * `~/.cache/claude-nomad/backup/<ts>/` is intentionally NOT created (no
 * backups are written under dryRun and an empty dir would pollute the cache).
 *
 * Any `NomadFatal` thrown along the way is caught here so the `finally` block
 * releases the lock before exit (a raw `process.exit()` would skip `finally`
 * and leak the lock, see `NomadFatal` JSDoc). Non-fatal errors rethrow.
 */
export function cmdPull(opts: { dryRun?: boolean } = {}): void {
  const dryRun = opts.dryRun === true;
  if (!existsSync(REPO_HOME)) die(`repo not cloned at ${REPO_HOME}`);
  // Fire the init-hint FATAL BEFORE acquireLock so an
  // unscaffolded repo never creates a lock file. Keyed off the same signal
  // regenerateSettings uses (shared/settings.base.json), so the two entry
  // points share one phrasing instead of diverging on edits.
  if (!existsSync(join(REPO_HOME, 'shared', 'settings.base.json'))) {
    die("repo not initialized; run 'nomad init' to scaffold");
  }
  const handle = acquireLock('pull');
  if (handle === null) process.exit(0);
  try {
    // Collision-resistant ts: nowTimestamp() is second-resolution, so two
    // pulls in the same wall-clock second would share `ts` and the second's
    // backupBeforeWrite calls (cpSync force:false) would silently no-op.
    const backupBase = join(HOME, '.cache', 'claude-nomad', 'backup');
    const ts = freshBackupTs(backupBase);
    if (!dryRun) {
      // Fail-fast: create backup root BEFORE any mutation. If mkdir fails
      // (out of disk, permission denied), die() throws (NomadFatal) and the
      // outer catch logs + sets exitCode, then finally releases the lock.
      // Skipped under dryRun: no backups are written, and an empty
      // backup-root dir would pollute the cache.
      const backupRoot = join(backupBase, ts);
      try {
        mkdirSync(backupRoot, { recursive: true });
      } catch (err) {
        die(`could not create backup dir: ${(err as Error).message}`);
      }
    }
    log(`pulling on host=${HOST} (backup=${ts}${dryRun ? '; dry-run' : ''})`);
    gitOrFatal(['pull', '--rebase', '--autostash'], 'git pull --rebase', REPO_HOME);
    if (dryRun) {
      const previewResult = computePreview(ts);
      log('dry-run complete; no mutation');
      emitSummary('pull', previewResult.unmapped);
    } else {
      applySharedLinks(ts);
      regenerateSettings(ts);
      const remapResult = remapPull(ts);
      log('pull complete');
      emitSummary('pull', remapResult.unmapped);
    }
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
