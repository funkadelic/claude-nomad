import { isAbsolute, normalize } from 'node:path';

import { NomadFatal } from './utils.ts';

/**
 * `logical` keys in `path-map.json` are project identifiers (e.g. `ha-acwd`,
 * `foo`), never path fragments. A crafted key like `../escape` or `foo/bar`
 * would escape `shared/extras/` via `join()` (which normalizes `..`) and land
 * content somewhere unexpected on the filesystem. The push allow-list catches
 * such commits at the `git add` boundary, but the filesystem mutation has
 * already happened by then. This check fails fast before any write. The
 * pattern matches what every reasonable project name looks like and rejects
 * everything else; tighten only if a real project needs broader characters.
 */
const SAFE_LOGICAL = /^[A-Za-z0-9._-]+$/;

/**
 * Throw `NomadFatal` unless `logical` is a path-separator-free project
 * identifier (see `SAFE_LOGICAL`). Path-traversal defense-in-depth; called
 * before any filesystem mutation by every extras op.
 */
export function assertSafeLogical(logical: string): void {
  if (!SAFE_LOGICAL.test(logical) || logical === '.' || logical === '..') {
    throw new NomadFatal(
      `invalid logical name in path-map.json extras: ${JSON.stringify(logical)} (must match [A-Za-z0-9._-]+; no path separators or '..')`,
    );
  }
}

/**
 * Reject `localRoot` values that contain unnormalized segments (`..`,
 * redundant `/.`, trailing slashes that don't survive `normalize`). A
 * poisoned `path-map.json` with `host: '/tmp/x/../escape'` would silently
 * land writes at `/tmp/escape/.planning/` because `path.join` normalizes
 * `..` before `cpSync` sees the destination. The user thinks they declared
 * one path and got another. Requiring `localRoot === normalize(localRoot)`
 * (and an absolute path on top) catches the obvious traversal trick and
 * forces poisoned-map writes to surface as a FATAL before any filesystem
 * mutation. Same defense-in-depth shape as `assertSafeLogical`.
 */
export function assertSafeLocalRoot(localRoot: string, logical: string): void {
  if (!isAbsolute(localRoot)) {
    throw new NomadFatal(
      `invalid localRoot for ${logical} in path-map.json: ${JSON.stringify(localRoot)} (must be absolute)`,
    );
  }
  if (localRoot !== normalize(localRoot)) {
    throw new NomadFatal(
      `invalid localRoot for ${logical} in path-map.json: ${JSON.stringify(localRoot)} (must be already-normalized; no '..' or redundant segments)`,
    );
  }
}
