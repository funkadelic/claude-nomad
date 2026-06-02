import { NEVER_SYNC } from './config.never-sync.ts';
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
 * separator, no shell-special character, no leading dot that would collide
 * with a hidden state directory.
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
 * Returns `true` when `entry` is a valid `sharedDirs` path segment: a single
 * path segment (no `/` or `..`), not present in `NEVER_SYNC`, and not a
 * reserved `shared/` name. Invalid entries are dropped with a WARN by the
 * caller (`allSharedLinks` in `config.ts`) rather than throwing a fatal error,
 * mirroring the resilience of the existing extras path.
 *
 * Accepts `unknown` because `path-map.json` is runtime input: a malformed
 * `sharedDirs` array can hold non-string values (numbers, objects, null) that
 * `SAFE_SEGMENT.test` would otherwise string-coerce (e.g. `42` -> `"42"`).
 * Rejecting non-strings first drops those shapes deterministically, and the
 * `entry is string` predicate narrows the value for callers that filter on it.
 *
 * @param entry - Candidate `sharedDirs` value from `path-map.json`.
 * @returns `true` if the entry is safe to use as a symlink target under `~/.claude/`.
 */
export function isValidSharedDir(entry: unknown): entry is string {
  if (typeof entry !== 'string') return false;
  if (!SAFE_SEGMENT.test(entry) || entry === '.' || entry === '..') return false;
  if (NEVER_SYNC.has(entry)) return false;
  if (RESERVED_SHARED.has(entry)) return false;
  return true;
}
