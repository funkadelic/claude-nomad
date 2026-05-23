import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { green, okGlyph, warnGlyph, yellow } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { compareSemver } from './commands.doctor.version.ts';

/**
 * Soft host-fitness check appended to the Version section of `nomad doctor`.
 * Compares the running node version (`process.version`) to the minimum required
 * by `engines.node` in `package.json`, emitting one of:
 *   - `✓ node: vX.Y.Z (satisfies >=A.B.C)` when current >= required
 *   - `⚠︎ node: vX.Y.Z (below required >=A.B.C, run \`nvm install\`)` when below
 * Every failure path (missing engines, unsupported range syntax, unreadable
 * `package.json`) is a SILENT skip; this module never sets `process.exitCode`
 * and never writes to stderr. Mirrors the philosophy of the sibling release-
 * version check in `commands.doctor.version.ts`.
 */

/** Strict `>=X.Y.Z` matcher. The project's `engines.node` field has always
 * used this form; anything more exotic (`^`, `~`, exact pin, OR ranges) is
 * out of scope and triggers the silent-skip path so we never falsely PASS or
 * falsely WARN on a spec we cannot parse with full confidence. */
const ENGINES_GTE = /^>=\s*(\d+\.\d+\.\d+)$/;

/**
 * Peel the minimum strict-semver out of an `engines.node` spec when the spec
 * is `>=X.Y.Z` (optional whitespace after `>=`). Returns the bare `X.Y.Z`
 * string. Any other shape (`^X.Y.Z`, `~X.Y.Z`, exact pins, OR ranges, bare
 * versions) returns `null` so the caller silently skips the diagnostic.
 */
export function parseMinVersion(spec: string): string | null {
  const m = ENGINES_GTE.exec(spec);
  return m ? m[1] : null;
}

/**
 * Locate and parse the local `package.json`, returning the `engines.node`
 * string when present, non-empty, and a string. Any throw (missing file,
 * parse error, etc.) becomes a `null` return so the caller silently skips.
 */
function readEnginesNode(): string | null {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      engines?: { node?: unknown };
    };
    const node = parsed.engines?.node;
    if (typeof node === 'string' && node.length > 0) return node;
    return null;
  } catch {
    return null;
  }
}

/**
 * Emit a single, non-fatal node-engine diagnostic for `nomad doctor` by
 * comparing `process.version` to the minimum required by `engines.node`.
 *
 * Logs one of:
 * - `✓ node: vX.Y.Z (satisfies >=A.B.C)` when current is at or above the minimum
 * - `⚠︎ node: vX.Y.Z (below required >=A.B.C, run \`nvm install\`)` when below
 *
 * Any failure to read `package.json`, locate `engines.node`, or parse the
 * range spec results in no output and does not change `process.exitCode`.
 */
export function reportNodeEngineCheck(section: DoctorSection): void {
  const required = readEnginesNode();
  if (required === null) return;
  const min = parseMinVersion(required);
  if (min === null) return;
  const current = process.version.replace(/^v/, '');
  const cmp = compareSemver(current, min);
  if (cmp === -1) {
    addItem(
      section,
      `${yellow(warnGlyph)} node: ${process.version} (below required >=${min}, run \`nvm install\`)`,
    );
    return;
  }
  addItem(section, `${green(okGlyph)} node: ${process.version} (satisfies >=${min})`);
}
