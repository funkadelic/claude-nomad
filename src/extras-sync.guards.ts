import { isAbsolute, normalize, sep } from 'node:path';

import { NomadFatal } from './utils.ts';

export { assertSafeLogical } from './config.sharedDirs.guard.ts';

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
 *
 * On win32, `normalize()` also canonicalizes `/` to `\` as part of separator
 * normalization (orthogonal to traversal safety), which would otherwise
 * reject a forward-slash-form Windows path-map value (e.g. `C:/Users/name`,
 * written by hand to avoid backslash JSON-escaping) even though it is
 * already traversal-free. The comparison is made against a
 * separator-canonicalized copy of `localRoot` so either separator style is
 * accepted on win32 while traversal segments (`..`, redundant `.`) are still
 * rejected regardless of which separator carries them. Non-win32 behavior is
 * unchanged (`sep` is `/` there, so the canonicalization is a no-op).
 */
export function assertSafeLocalRoot(localRoot: string, logical: string): void {
  if (!isAbsolute(localRoot)) {
    throw new NomadFatal(
      `invalid localRoot for ${logical} in path-map.json: ${JSON.stringify(localRoot)} (must be absolute)`,
    );
  }
  const canonical = process.platform === 'win32' ? localRoot.split('/').join(sep) : localRoot;
  if (canonical !== normalize(canonical)) {
    throw new NomadFatal(
      `invalid localRoot for ${logical} in path-map.json: ${JSON.stringify(localRoot)} (must be already-normalized; no '..' or redundant segments)`,
    );
  }
}
