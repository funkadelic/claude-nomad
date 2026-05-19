import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { HOME, HOST, REPO_HOME } from './config.ts';
import { applySharedLinks, regenerateSettings } from './links.ts';
import { remapPull } from './remap.ts';
import { acquireLock, die, freshBackupTs, log, NomadFatal, releaseLock } from './utils.ts';

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
 * `nomad pull` command. Acquires the push/pull lock, takes a backup
 * timestamp, runs `git pull --rebase --autostash` in `REPO_HOME`, then
 * applies the three side-effecting sync steps in order:
 *   1. `applySharedLinks` (symlink shared/* into ~/.claude/)
 *   2. `regenerateSettings` (deep-merge base + host-override into settings.json)
 *   3. `remapPull` (copy repo-side session transcripts into host-encoded dirs)
 *
 * Any `NomadFatal` thrown along the way is caught here so the `finally` block
 * releases the lock before exit (a raw `process.exit()` would skip `finally`
 * and leak the lock, see `NomadFatal` JSDoc). Non-fatal errors rethrow.
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
