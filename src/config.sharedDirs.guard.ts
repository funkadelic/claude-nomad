import { isSecretFileName, NEVER_SYNC } from './config.never-sync.ts';
import { NomadFatal } from './utils.ts';

/**
 * `logical` keys in `path-map.json` are project identifiers (e.g. `ha-acwd`,
 * `foo`), never path fragments. A crafted key like `../escape` or `foo/bar`
 * would escape `shared/projects/` (or `shared/extras/`) via `join()` (which
 * normalizes `..`) and land content somewhere unexpected on the filesystem.
 * The push allow-list catches such commits at the `git add` boundary, but the
 * filesystem mutation has already happened by then. This check fails fast
 * before any write. The pattern matches what every reasonable project name
 * looks like and rejects everything else.
 */
const SAFE_LOGICAL = /^[A-Za-z0-9._-]+$/;

/**
 * Throw `NomadFatal` unless `logical` is a path-separator-free project
 * identifier (see `SAFE_LOGICAL`). Path-traversal defense-in-depth; called
 * before any filesystem mutation by every remap and extras op that joins
 * `logical` into a filesystem path.
 *
 * @param logical - A `path-map.json` projects key to validate.
 */
export function assertSafeLogical(logical: string): void {
  if (!SAFE_LOGICAL.test(logical) || logical === '.' || logical === '..') {
    throw new NomadFatal(
      `invalid logical name in path-map.json: ${JSON.stringify(logical)} (must match [A-Za-z0-9._-]+; no path separators or '..')`,
    );
  }
}

/**
 * Single-segment path characters allowed in a `sharedDirs` entry. Mirrors
 * `SAFE_LOGICAL` above but applied to global support directory names rather
 * than per-project logical names. Must match `^[A-Za-z0-9._-]+$` so no path
 * separator and no shell-special character reach the filesystem join. This is
 * a character and separator test only: it does not reject a credential-shaped
 * name (`.env` matches the pattern), which is a separate later check.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Names that already exist under `shared/` (as repo-structural files or as
 * members of `SHARED_LINKS`) that a `sharedDirs` entry must not collide with.
 * Adding a `sharedDirs` entry matching one of these would either shadow a
 * structural file or create a duplicate symlink pointing at the same target.
 */
const RESERVED_SHARED = new Set([
  'settings.base.json',
  'CLAUDE.md',
  'agents',
  'skills',
  'commands',
  'rules',
  'my-statusline.cjs',
  'hooks',
  'hosts',
  'path-map.json',
  'extras',
  'projects',
]);

/**
 * Machine-comparable cause for a rejected `sharedDirs` entry, in the order
 * `validateSharedDirEntry` tests them. A string-literal union, not a TS
 * `enum`, because `erasableSyntaxOnly` forbids enums.
 */
export type SharedDirRejectionReason =
  'not-a-string' | 'not-a-segment' | 'never-sync' | 'reserved' | 'secret-shaped';

/**
 * Result of a failed `validateSharedDirEntry` check: a machine-comparable
 * `reason` identifier plus a human-readable `message` fragment. Callers that
 * only need pass/fail use `isValidSharedDir` instead.
 */
export type SharedDirRejection = {
  reason: SharedDirRejectionReason;
  message: string;
};

/**
 * Validate a `sharedDirs` entry from `path-map.json` and name the specific
 * reason a rejected entry was refused. Returns `null` when `entry` is safe to
 * use as a symlink target under `~/.claude/`; otherwise returns the first
 * matching {@link SharedDirRejection}, testing causes in this fixed order so
 * an existing rejection never changes its reported cause: not a string, not a
 * single path segment, a `NEVER_SYNC` member, a reserved `shared/` name, then
 * a credential-shaped filename. The credential-shape check runs last so a
 * `NEVER_SYNC` member that also looks credential-shaped (e.g.
 * `.credentials.json`) keeps reporting `never-sync`.
 *
 * Accepts `unknown` because `path-map.json` is runtime input: a malformed
 * `sharedDirs` array can hold non-string values (numbers, objects, null) that
 * `SAFE_SEGMENT.test` would otherwise string-coerce (e.g. `42` -> `"42"`).
 * Rejecting non-strings first drops those shapes deterministically.
 *
 * @param entry - Candidate `sharedDirs` value from `path-map.json`.
 * @returns `null` if safe; otherwise the rejection reason and message.
 */
export function validateSharedDirEntry(entry: unknown): SharedDirRejection | null {
  if (typeof entry !== 'string') {
    return { reason: 'not-a-string', message: 'not a string' };
  }
  if (!SAFE_SEGMENT.test(entry) || entry === '.' || entry === '..') {
    return {
      reason: 'not-a-segment',
      message:
        'not a single path segment (contains a path separator, an unsupported character, "." or "..")',
    };
  }
  if (NEVER_SYNC.has(entry)) {
    return { reason: 'never-sync', message: 'a never-sync name' };
  }
  if (RESERVED_SHARED.has(entry)) {
    return { reason: 'reserved', message: 'a reserved shared/ name' };
  }
  if (isSecretFileName(entry)) {
    return {
      reason: 'secret-shaped',
      message: 'a credential-shaped filename (.env, id_rsa, credentials, *.pem, *.key and similar)',
    };
  }
  return null;
}

/**
 * Boolean wrapper over {@link validateSharedDirEntry}: `true` when `entry` is
 * a valid `sharedDirs` path segment (a single path segment not present in
 * `NEVER_SYNC`, not a reserved `shared/` name, and not a credential-shaped
 * filename). Invalid entries are dropped with a WARN by the caller
 * (`allSharedLinks` in `config.ts`) rather than throwing a fatal error,
 * mirroring the resilience of the existing extras path.
 *
 * Kept as a thin same-signature wrapper so its three consumers (`config.ts`,
 * `commands.adopt.ts`, `commands.push.allowlist.ts`) inherit the
 * credential-shape rejection with no edit to any call site.
 *
 * @param entry - Candidate `sharedDirs` value from `path-map.json`.
 * @returns `true` if the entry is safe to use as a symlink target under `~/.claude/`.
 */
export function isValidSharedDir(entry: unknown): entry is string {
  return validateSharedDirEntry(entry) === null;
}
