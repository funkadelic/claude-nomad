/**
 * The win32-only copy-sync half of `applySharedLinks`, extracted from
 * `links.ts` so the repo-to-host write half lives beside itself. Mirrors
 * `links.mirror.ts` (the host-to-repo half) as a sibling module.
 */

import { existsSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { ALWAYS_NEVER_SYNC, isDeniedName, type ValidatedSharedNames } from '../core/config.ts';
import { copyExtrasFilteredPreservingBy } from './extras/core.ts';
import { log, warn, NomadFatal } from '../core/utils.ts';
import { backupBeforeWrite } from '../core/utils.fs.ts';

/**
 * Copies `shared/<name>` from the repo into `~/.claude/<name>` on win32,
 * filtered by `ALWAYS_NEVER_SYNC` (not the full `NEVER_SYNC`: this is the
 * read half, see `links.mirror.ts`'s wider filter for the write half).
 */
export function copySharedLinkPull(src: string, dst: string): void {
  copyExtrasFilteredPreservingBy(src, dst, (name) => isDeniedName(ALWAYS_NEVER_SYNC, name));
}

/** Whether something (possibly a dangling symlink) still occupies `abs`; an unstat-able path reports present rather than guessing absent. */
function stillOccupied(abs: string): boolean {
  try {
    return lstatSync(abs, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}

/** Outcome of `snapshotBeforeWin32Copy`: only `failed` stops the copy; only `snapshotted` names a backup dir afterwards. */
type Win32SnapshotOutcome = 'snapshotted' | 'nothing-to-snapshot' | 'failed';

/**
 * Snapshots the `~/.claude/<name>` entry before a win32 copy overwrites it.
 * A failed snapshot abandons the copy for that name rather than proceeding
 * unbacked.
 */
function snapshotBeforeWin32Copy(linkPath: string, ts: string): Win32SnapshotOutcome {
  try {
    return backupBeforeWrite(linkPath, ts) ? 'snapshotted' : 'nothing-to-snapshot';
  } catch (err) {
    warn(
      `could not snapshot ${linkPath} before updating it (${(err as Error).message}), so it was left as it is. The rest of the pull continues`,
    );
    return 'failed';
  }
}

/**
 * Warns that a win32 copy for `linkPath` failed, stating only what
 * `stillOccupied` and the snapshot outcome actually establish.
 */
function warnWin32ApplyFailed(
  linkPath: string,
  ts: string,
  err: unknown,
  snapshotted: boolean,
): void {
  const state = stillOccupied(linkPath)
    ? 'it may be unchanged, or partly updated'
    : 'nothing is at that path now';
  const recover = snapshotted
    ? ` A copy of what it held before this pull is under backup/${ts}/.`
    : '';
  warn(
    `${linkPath} could not be updated (${(err as Error).message}), so ${state}.${recover} The rest of the pull continues. Check its permissions, or whether another program has it open, then run 'nomad pull' again to update it`,
  );
}

/**
 * Emits a dry-run copy preview event, or falls back to `log()`. Typed
 * narrowly (only the `copy` shape) so this module never imports `links.ts`.
 */
function emitCopy(
  onPreview: ((e: { kind: 'copy'; from: string; to: string }) => void) | undefined,
  from: string,
  to: string,
): void {
  if (onPreview) {
    onPreview({ kind: 'copy', from, to });
  } else {
    log(`would copy: ${from} -> ${to}`);
  }
}

/**
 * Wet-path apply for one win32 shared name: snapshot, clear a symlink-era
 * leftover, then overlay. A `NomadFatal` rethrows; any other failure warns
 * and continues so one locked file doesn't abort the whole pull.
 */
function applyOneSharedLinkWin32(target: string, linkPath: string, ts: string): void {
  let snapshotted = false;
  try {
    const stat = lstatSync(linkPath, { throwIfNoEntry: false });
    if (stat !== undefined) {
      const snapshot = snapshotBeforeWin32Copy(linkPath, ts);
      if (snapshot === 'failed') return;
      snapshotted = snapshot === 'snapshotted';
      if (stat.isSymbolicLink()) {
        rmSync(linkPath, { recursive: true, force: true });
      }
    }
    copySharedLinkPull(target, linkPath);
  } catch (err) {
    if (err instanceof NomadFatal) throw err;
    warnWin32ApplyFailed(linkPath, ts, err, snapshotted);
  }
}

/**
 * Win32 branch of `applySharedLinks`: materializes each shared name as a real
 * copy (`copySharedLinkPull`) instead of a symlink, since Windows symlinks
 * need Developer Mode or admin. Skips a name with no `shared/<name>`
 * counterpart; a pre-existing entry is snapshotted first, so it stays recoverable.
 */
export function applySharedLinksWin32(
  linkNames: ValidatedSharedNames,
  claude: string,
  repo: string,
  ts: string,
  dryRun: boolean,
  onPreview: ((e: { kind: 'copy'; from: string; to: string }) => void) | undefined,
): void {
  for (const name of linkNames) {
    const target = join(repo, 'shared', name);
    if (!existsSync(target)) continue;
    const linkPath = join(claude, name);
    if (dryRun) {
      emitCopy(onPreview, linkPath, target);
      continue;
    }
    applyOneSharedLinkWin32(target, linkPath, ts);
  }
}
