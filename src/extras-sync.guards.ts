import { isAbsolute, normalize } from 'node:path';

import { assertSafeLogical } from './config.sharedDirs.guard.ts';
import { NomadFatal } from './utils.ts';

export { assertSafeLogical };

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
