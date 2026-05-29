import { NEVER_SYNC } from './config.ts';

/**
 * Single-segment path characters allowed in a `sharedDirs` entry. Mirrors
 * `SAFE_LOGICAL` in `extras-sync.guards.ts` but applied to global support
 * directory names rather than per-project logical names. Must match
 * `^[A-Za-z0-9._-]+$` so no path separator, no shell-special character, no
 * leading dot that would collide with a hidden state directory.
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
