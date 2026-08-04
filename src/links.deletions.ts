/**
 * Deletion half of the win32 host-to-repo shared-config reconcile.
 *
 * The mirror in `links.ts` is additive by design: it copies what the host has
 * into the repo and never removes anything. That leaves one asymmetry against
 * posix, where a shared name is a symlink and deleting a file inside it IS a
 * repo deletion. Without this pass a file the user deleted on win32 is put back
 * by the same pull's repo-to-local overlay, forever.
 *
 * Everything here is gated on the per-host baseline (`links.baseline.ts`), which
 * is the entire safety argument: it distinguishes a file the user removed from a
 * file this host has never received. Every way of failing to read it resolves to
 * planning nothing. The pass removes files from the repo WORKTREE only and runs
 * no git command at all; staging, the secret scan, and the commit stay with the
 * push pipeline exactly as they do for the mirror.
 */

import { existsSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import {
  allSharedLinks,
  claudeHome,
  isDeniedName,
  repoHome,
  ALWAYS_NEVER_SYNC,
  type PathMap,
} from './config.ts';
import { enumerateLocalSharedFiles, readSharedBaseline } from './links.baseline.ts';
import { diffManifest, hashFile } from './push-manifest.ts';
import { backupRepoWrite } from './utils.fs.ts';

/**
 * Stable stand-in returned when a file's hash cannot be read. `diffManifest`
 * calls its hash callback only while computing the `changed` set, which this
 * consumer discards (the content gate for additions and edits is the eager
 * mirror, which copies unconditionally and lets git decide what really moved).
 * So the value is never compared against anything that matters; what matters is
 * that a file vanishing mid-run cannot throw out of the pull.
 */
const HASH_UNAVAILABLE = 'unreadable';

/** One repo file the pass will remove, with the local absence that authorized it. */
export type SharedLinkDeletion = {
  /** The shared name the file lives under (`commands`, `rules`, ...). */
  name: string;
  /** Absolute path the file no longer occupies under `~/.claude/`. */
  localPath: string;
  /** Absolute path of the repo-side file to remove from the worktree. */
  repoPath: string;
};

/** Hash `abs`, degrading to a stable sentinel rather than throwing. */
function safeHash(abs: string): string {
  try {
    return hashFile(abs);
  } catch {
    return HASH_UNAVAILABLE;
  }
}

/**
 * Turn one baseline key that is no longer present locally into a deletion, or
 * `null` when any scoping rule declines it. The rules, in order:
 *
 * - The key's first segment must still be a configured shared name. A name the
 *   user has since dropped from `sharedDirs` must not have its old entries acted
 *   on.
 * - That name's local path must still exist. A whole missing directory is not a
 *   deletion; it is an unmounted drive, a rename, or an interrupted pull, and
 *   treating it as one would empty the repo.
 * - The basename must not be denied, so a credential or per-host file injected
 *   into a hand-written baseline cannot direct a removal.
 * - The re-anchored repo path must stay inside the repo's `shared/` directory.
 *   This is the only place in the pass where a value read off disk becomes an
 *   `rmSync` target. The escape test matches `backupUnder`: reject an empty
 *   result, a bare `..`, or a `..` followed by a separator, so the check lands
 *   on a path-segment boundary and a sibling merely NAMED `..config` still
 *   passes.
 * - The repo file must exist. Nothing to remove otherwise.
 */
function deletionFor(
  key: string,
  names: Set<string>,
  claude: string,
  sharedRoot: string,
): SharedLinkDeletion | null {
  const segments = key.split('/');
  const name = segments[0];
  if (!names.has(name)) return null;
  if (!existsSync(join(claude, name))) return null;
  if (isDeniedName(ALWAYS_NEVER_SYNC, segments[segments.length - 1])) return null;
  const repoPath = resolve(sharedRoot, key);
  const rel = relative(sharedRoot, repoPath);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  if (!existsSync(repoPath)) return null;
  return { name, localPath: join(claude, key), repoPath };
}

/**
 * Plan which repo-side shared files a local deletion authorizes removing. Pure
 * and read-only: it mutates nothing, so a caller can render it as a preview or
 * hand it straight to the applier.
 *
 * Returns an empty plan on darwin and linux (checked first, so posix pays
 * nothing), on a map that could not be read, and on any baseline that cannot be
 * trusted. That last line is what makes every baseline-integrity failure, absent
 * through malformed through foreign-producer, resolve to deleting nothing.
 *
 * @param map - Parsed `path-map.json`, or `null` when it could not be read.
 * @returns One entry per repo file to remove; empty when nothing is authorized.
 */
export function planSharedLinkDeletions(map: PathMap | null): SharedLinkDeletion[] {
  if (process.platform !== 'win32') return [];
  if (map === null) return [];
  const baseline = readSharedBaseline();
  if (baseline === null) return [];
  const claude = claudeHome();
  const sharedRoot = join(repoHome(), 'shared');
  const current = enumerateLocalSharedFiles(map);
  const { deleted } = diffManifest(baseline, current, (key) => safeHash(join(claude, key)));
  const names = new Set(allSharedLinks(map));
  const plan: SharedLinkDeletion[] = [];
  for (const key of deleted) {
    const entry = deletionFor(key, names, claude, sharedRoot);
    if (entry !== null) plan.push(entry);
  }
  return plan;
}

/**
 * Remove every repo file `planSharedLinkDeletions` authorized, snapshotting each
 * one into the pull's own timestamped backup cache first so a wrong removal is
 * recoverable from the same place every other pull-side overwrite lands.
 *
 * Files only, never directories and never recursive. Removing the last file from
 * a repo directory therefore leaves an empty directory behind; git does not
 * track those, so the commit is clean, and posix behaves identically when the
 * last file inside a symlinked directory goes away.
 *
 * @param map - Parsed `path-map.json`, or `null` when it could not be read.
 * @param ts - Backup timestamp, already resolved by the pull.
 */
export function applySharedLinkDeletions(map: PathMap | null, ts: string): void {
  const repo = repoHome();
  for (const entry of planSharedLinkDeletions(map)) {
    backupRepoWrite(entry.repoPath, ts, repo);
    rmSync(entry.repoPath, { force: true });
  }
}
