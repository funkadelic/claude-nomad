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

import { existsSync, lstatSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import {
  allSharedLinks,
  claudeHome,
  isDeniedName,
  repoHome,
  ALWAYS_NEVER_SYNC,
  type PathMap,
} from './config.ts';
import { enumerateLocalSharedScan, readSharedBaseline } from './links.baseline.ts';
import { warn } from './utils.ts';
import { backupRepoWrite } from './utils.fs.ts';

/** One repo file the pass will remove, with the local absence that authorized it. */
export type SharedLinkDeletion = {
  /** The shared name the file lives under (`commands`, `rules`, ...). */
  name: string;
  /** Absolute path the file no longer occupies under `~/.claude/`. */
  localPath: string;
  /** Absolute path of the repo-side file to remove from the worktree. */
  repoPath: string;
};

/**
 * True when `key` names, or sits beneath, a path the local walk declined to
 * read (a live symlink, an unlistable directory, an unstattable entry, a denied
 * name). Such a key is absent from the recorded set for a reason that is not a
 * deletion, so acting on it would remove a repo file nobody asked to remove.
 *
 * The test lands on a path-segment boundary rather than being a bare prefix
 * match, so a declined `commands/sub` does not also swallow a sibling
 * `commands/subtitle.md`. Both sides arrive already lowercased; see
 * {@link planSharedLinkDeletions} for why case is folded.
 *
 * @param declined - Lowercased relative POSIX paths the walk declined.
 * @param key - Lowercased baseline key under test.
 */
function isUnknown(declined: string[], key: string): boolean {
  return declined.some((prefix) => key === prefix || key.startsWith(`${prefix}/`));
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
 * - NO segment may be denied, matching the walk that produces the record: it
 *   applies the deny predicate at every depth, so a key with a denied segment
 *   anywhere could only have come from a hand-written baseline, and a
 *   credential or per-host file must never direct a removal.
 * - The re-anchored repo path must stay inside `shared/<name>`, not merely
 *   inside `shared/`. This is the only place in the pass where a value read off
 *   disk becomes an `rmSync` target, and anchoring on the name is what stops a
 *   key that passed the name gate from redirecting the removal at a SIBLING
 *   name whose local file is present. The escape test matches `backupUnder`:
 *   reject an empty result, a bare `..`, or a `..` followed by a separator, so
 *   the check lands on a path-segment boundary and a sibling merely NAMED
 *   `..config` still passes.
 * - No segment may be `..`, `.`, or empty. The containment check above proves
 *   the resolved TARGET is in bounds; this proves the key itself is a plain
 *   relative path, which is what makes the reported local path (built by
 *   joining the raw key) describe the same file the repo path does.
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
  if (segments.some((segment) => isDeniedName(ALWAYS_NEVER_SYNC, segment))) return null;
  const repoPath = resolve(sharedRoot, key);
  const rel = relative(join(sharedRoot, name), repoPath);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    return null;
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
 * A recorded key is a deletion candidate only when it is absent from the walk
 * AND no declined path sits above it, so an unreadable subtree or a name that
 * has since become a symlink authorizes nothing rather than everything under
 * it. Presence is tested with case folded, because this runs on win32 only and
 * NTFS is case-insensitive: without folding, renaming `commands/Foo.md` to
 * `foo.md` reads as a deletion of the old key whose repo path then resolves to
 * the file the mirror wrote moments earlier under the new casing.
 *
 * The absence test is written out rather than routed through `diffManifest`,
 * whose `changed` half this consumer discards: computing it hashes every file
 * whose size matches the record and whose mtime moved, which a git checkout
 * makes the common case, so the read-only surfaces would pay a full content
 * read of the shared tree for a value nobody looks at.
 *
 * `opts.linkNames`, when supplied, is used verbatim instead of deriving the
 * name list from `map` internally, so a caller (`reconcileSharedLinksBeforePull`)
 * that already derived `allSharedLinks(map)` once for the mirror pass can
 * thread the same list through here instead of triggering a second
 * `sharedDirs` rejection WARN for the same invalid entry.
 *
 * @param map - Parsed `path-map.json`, or `null` when it could not be read.
 * @param opts - `linkNames`; falls back to `allSharedLinks(map)` when absent.
 * @returns One entry per repo file to remove; empty when nothing is authorized.
 */
export function planSharedLinkDeletions(
  map: PathMap | null,
  opts: { linkNames?: readonly string[] } = {},
): SharedLinkDeletion[] {
  if (process.platform !== 'win32') return [];
  if (map === null) return [];
  const baseline = readSharedBaseline();
  if (baseline === null) return [];
  const claude = claudeHome();
  const sharedRoot = join(repoHome(), 'shared');
  const scan = enumerateLocalSharedScan(map);
  const present = new Set(Object.keys(scan.files).map((key) => key.toLowerCase()));
  const declined = scan.declined.map((path) => path.toLowerCase());
  const names = new Set(opts.linkNames ?? allSharedLinks(map));
  const plan: SharedLinkDeletion[] = [];
  for (const key of Object.keys(baseline.files)) {
    const folded = key.toLowerCase();
    if (present.has(folded)) continue;
    if (isUnknown(declined, folded)) continue;
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
 * last file inside a symlinked directory goes away. A repo path that turns out
 * to be a directory (a type change another host pushed) is skipped rather than
 * raising, since a non-recursive removal cannot act on it anyway.
 *
 * Each entry is contained: a snapshot or removal that fails warns and the loop
 * moves on, so one unremovable file cannot cancel the removals planned after
 * it. Silently abandoning the rest would leave the repo half-reconciled while
 * the run reported nothing about the entries it never reached.
 *
 * `opts.linkNames`, when supplied, is threaded through to `planSharedLinkDeletions`
 * verbatim; see that function's doc comment for why.
 *
 * @param map - Parsed `path-map.json`, or `null` when it could not be read.
 * @param ts - Backup timestamp, already resolved by the pull.
 * @param opts - `linkNames`; falls back to `allSharedLinks(map)` when absent.
 */
export function applySharedLinkDeletions(
  map: PathMap | null,
  ts: string,
  opts: { linkNames?: readonly string[] } = {},
): void {
  const repo = repoHome();
  for (const entry of planSharedLinkDeletions(map, opts)) {
    try {
      if (!lstatSync(entry.repoPath).isFile()) continue;
      backupRepoWrite(entry.repoPath, ts, repo);
      rmSync(entry.repoPath, { force: true });
    } catch (err) {
      warn(`could not remove ${entry.repoPath}: ${(err as Error).message}`);
    }
  }
}
