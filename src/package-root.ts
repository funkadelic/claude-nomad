import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory holding this module, the default starting point for the walk. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Nearest ancestor directory holding a `package.json`, walking up from `from`.
 *
 * Depth-independent on purpose. A fixed `new URL('../…', import.meta.url)` hop
 * count cannot serve both `src/`, where nesting varies per module, and the
 * esbuild bundle, which is always one level under the package root. A wrong hop
 * count there is silent: every caller of a package-root asset treats a failed
 * read as "diagnostic unavailable" and carries on.
 *
 * Throws when no ancestor has a `package.json`, which means a broken install
 * rather than a missing optional file. Callers that already funnel failures
 * into a null return catch it as they catch any other read failure.
 *
 * @param from Directory to start from; defaults to this module's own directory.
 */
export function packageRoot(from: string = HERE): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json above ${from}`);
    dir = parent;
  }
}
