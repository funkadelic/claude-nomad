/**
 * Validates a user-owned `.gitleaks.overlay.toml` before it is chained onto the
 * bundled ruleset. The overlay syncs to every host, so an allowlist that is not
 * scoped to specific files would disable secret scanning fleet-wide.
 */

import { parse } from 'smol-toml';

import { NomadFatal } from '../../core/utils.ts';

type Table = Record<string, unknown>;

/** A pattern that matches anything (`.*`, `.+`, `^.*$`, `(.*)`, ...). */
const CATCH_ALL_RE = /^\^?\(?\.[*+]\)?\$?$/;

/** Paths no scoped pattern should match: one that does allows every file. */
const CANARY_PATHS = ['nomad-canary-q7z/zz9.qk', 'zz9q7.qk'];

/** Keys that narrow an allowlist to specific matches rather than whole files. */
const MATCHER_KEYS = ['regexes', 'stopwords', 'commits'];

/**
 * True for a TOML table (not an array or scalar).
 * @param value A parsed TOML value.
 */
function isTable(value: unknown): value is Table {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `table` with lowercased keys, since gitleaks matches config keys in any case.
 * Rejects two keys differing only in case: gitleaks silently keeps one of them.
 * @param table A parsed TOML table.
 */
function lowerKeys(table: Table): Table {
  const out: Table = {};
  for (const [key, value] of Object.entries(table)) {
    const lower = key.toLowerCase();
    if (lower in out) {
      throw new NomadFatal(
        `.gitleaks.overlay.toml repeats the key "${lower}" in different letter cases; keep one.`,
      );
    }
    out[lower] = value;
  }
  return out;
}

/**
 * Reject a quoted key containing a dot anywhere in the overlay: gitleaks' config
 * loader splits `"allowlist.regexes"` into nested tables, past these checks.
 * @param value A parsed TOML value.
 */
function assertNoDottedKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoDottedKeys);
    return;
  }
  if (!isTable(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key.includes('.')) {
      throw new NomadFatal(
        `.gitleaks.overlay.toml key "${key}" contains a dot, which gitleaks splits into nested tables. Use a [table] header instead.`,
      );
    }
    assertNoDottedKeys(child);
  }
}

/**
 * True when a `paths` pattern matches an unrelated canary path, or is not a
 * string or not compilable as a JS regex (so it cannot be checked).
 * @param pattern One `paths` entry (a Go regex; a leading `(?flags)` maps to JS flags).
 */
function isBroadPath(pattern: unknown): boolean {
  if (typeof pattern !== 'string') return true;
  const [prefix = '', flags = ''] = /^\(\?([imsU]+)\)/.exec(pattern) ?? [];
  let re: RegExp;
  try {
    re = new RegExp(pattern.slice(prefix.length), flags.replace('U', ''));
  } catch {
    return true;
  }
  return CANARY_PATHS.some((path) => re.test(path));
}

/**
 * Parse the overlay, turning a syntax error into a `NomadFatal`.
 * @param overlayBody The overlay file contents.
 */
function parseOverlay(overlayBody: string): Table {
  try {
    const doc = parse(overlayBody);
    assertNoDottedKeys(doc);
    return lowerKeys(doc);
  } catch (err) {
    if (err instanceof NomadFatal) throw err;
    throw new NomadFatal(`.gitleaks.overlay.toml is not valid TOML: ${(err as Error).message}`);
  }
}

/**
 * Every allowlist table in the overlay, from `[allowlist]` and `[[allowlists]]`.
 * @param doc The parsed overlay with lowercased top-level keys.
 */
function allowlistTables(doc: Table): Table[] {
  const entries: unknown[] = [doc.allowlist, doc.allowlists].flat().filter((e) => e !== undefined);
  if (!entries.every(isTable)) {
    throw new NomadFatal(
      '.gitleaks.overlay.toml allowlists must be tables; use [[allowlists]] blocks.',
    );
  }
  return entries.map(lowerKeys);
}

/**
 * Reject an allowlist with a catch-all pattern, no `paths`, or matchers
 * without `condition = "AND"` (without AND, a path match alone allows a finding).
 * @param allowlist One allowlist table with lowercased keys.
 */
function assertAllowlistScoped(allowlist: Table): void {
  const regexes = [allowlist.regexes].flat();
  if (regexes.some((p) => typeof p === 'string' && CATCH_ALL_RE.test(p))) {
    throw new NomadFatal(
      '.gitleaks.overlay.toml allowlist contains a catch-all pattern (.* or .+) that would suppress every finding. Replace it with a specific, anchored pattern.',
    );
  }
  if (!Array.isArray(allowlist.paths) || allowlist.paths.length === 0) {
    throw new NomadFatal(
      '.gitleaks.overlay.toml allowlist must be path-scoped: every [[allowlists]] block needs a `paths` entry so it cannot suppress findings repo-wide. Anchor `paths` to the files you intend to allow (e.g. shared/projects/<logical>/...jsonl).',
    );
  }
  const broad: unknown = allowlist.paths.find(isBroadPath);
  if (broad !== undefined) {
    throw new NomadFatal(
      `.gitleaks.overlay.toml allowlist path ${JSON.stringify(broad)} is a catch-all: it matches unrelated files, or nomad cannot check its regex syntax. Anchor it to the files you intend to allow.`,
    );
  }
  const isAnd = String(allowlist.condition).toUpperCase() === 'AND';
  if (MATCHER_KEYS.some((key) => key in allowlist) && !isAnd) {
    throw new NomadFatal(
      '.gitleaks.overlay.toml allowlist with both `paths` and `regexes` (or `stopwords`/`commits`) needs `condition = "AND"`; without it every finding in the listed files is ignored, not just the matching ones.',
    );
  }
}

/**
 * Throw `NomadFatal` unless the overlay is valid TOML with no `extend` table and
 * only path-scoped allowlists. Returns whether it uses a legacy `[allowlist]`
 * table, which gitleaks refuses to mix with `[[allowlists]]`.
 * @param overlayBody The already-read overlay file contents.
 */
export function assertOverlaySafe(overlayBody: string): { legacy: boolean } {
  const doc = parseOverlay(overlayBody);
  if ('extend' in doc) {
    throw new NomadFatal(
      '.gitleaks.overlay.toml must not contain an [extend] block; it is generated automatically. Remove the [extend] section and retry.',
    );
  }
  for (const allowlist of allowlistTables(doc)) assertAllowlistScoped(allowlist);
  return { legacy: doc.allowlist !== undefined };
}
