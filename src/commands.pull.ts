import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { HOME, HOST, REPO_HOME } from './config.ts';
import { divergenceCheckExtras, remapExtrasPull } from './extras-sync.ts';
import { applySharedLinks, regenerateSettings } from './links.ts';
import { computePreview } from './preview.ts';
import { remapPull } from './remap.ts';
import { emitSummary } from './summary.ts';
import { die, fail, gitOrFatal, log, NomadFatal } from './utils.ts';
import { freshBackupTs } from './utils.fs.ts';
import { acquireLock, releaseLock } from './utils.lockfile.ts';

/**
 * `nomad pull` command. Acquires the push/pull lock, takes a backup
 * timestamp, runs `git pull --rebase --autostash` in `REPO_HOME`, then
 * applies the side-effecting sync steps in order:
 *   1. `divergenceCheckExtras` (read-only WARN naming local files that
 *      diverge from origin; fires in BOTH wet and dry modes per D-08)
 *   2. `applySharedLinks` (symlink shared/* into ~/.claude/)
 *   3. `regenerateSettings` (deep-merge base + host-override into settings.json)
 *   4. `remapPull` (copy repo-side session transcripts into host-encoded dirs)
 *   5. `remapExtrasPull` (copy `shared/extras/<logical>/<dirname>/` back
 *      into each project's localRoot; SKIPPED under dryRun)
 *
 * `opts.dryRun` (default `false`): when `true`, the lock IS still acquired
 * and `git pull --rebase` still runs (so concurrent invocations cannot race
 * and the user sees the same network round-trip as a real pull).
 * `divergenceCheckExtras` still fires (read-only by design). Then
 * `computePreview` runs in place of the four mutating steps. The per-run
 * backup directory under `~/.cache/claude-nomad/backup/<ts>/` is
 * intentionally NOT created (no backups are written under dryRun and an
 * empty dir would pollute the cache).
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
    // Read-only pre-pull check: fires in BOTH wet and dry modes (D-08).
    // Runs AFTER the rebase (so origin content is fetched) and BEFORE any
    // mutation (so local state is intact for byte-level comparison). The
    // function itself silently skips when no `extras` key is declared.
    divergenceCheckExtras(ts);
    if (dryRun) {
      const previewResult = computePreview(ts);
      // dryRun deliberately omits remapExtrasPull to preserve the
      // zero-mutation contract; users still see the divergence WARN above.
      log('dry-run complete; no mutation');
      emitSummary('pull', previewResult.unmapped);
    } else {
      applySharedLinks(ts);
      regenerateSettings(ts);
      const remapResult = remapPull(ts);
      const extrasResult = remapExtrasPull(ts);
      log('pull complete');
      // Combine session-unmapped and extras-unmapped into one user-visible
      // count; from the operator's perspective both mean "couldn't sync this
      // for the host". extras-skipped (non-whitelisted dirname) stays
      // separate because it signals config misuse, not a host-config gap.
      emitSummary('pull', remapResult.unmapped + extrasResult.unmapped, 0, extrasResult.skipped);
    }
  } catch (err) {
    // Catch fatal errors here so the finally block runs and releases the
    // lock. Throwing through process.exit() would skip finally.
    if (err instanceof NomadFatal) {
      fail(err.message);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    releaseLock(handle);
  }
}
