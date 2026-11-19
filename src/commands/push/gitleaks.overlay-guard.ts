/**
 * Validates a user-owned `.gitleaks.overlay.toml` before it is chained onto the
 * bundled ruleset. The overlay syncs to every host, so an allowlist that is not
 * scoped to specific files would disable secret scanning fleet-wide. It also
 * strips the global blocks a single-file scan cannot scope.
 */

import { parse, stringify, type TomlError } from 'smol-toml';

import { NomadFatal } from '../../core/utils.ts';
import { GITLEAKS_DEFAULT_RULE_IDS } from './gitleaks.default-rule-ids.ts';

type Table = Record<string, unknown>;

/** Paths no scoped pattern should match, including one per common synced file type. */
const CANARY_PATHS = [
  'zz9q7.qk',
  ...['qk', 'md', 'json', 'jsonl', 'toml', 'txt', 'yml'].map(
    (ext) => `nomad-canary-q7z/zz9.${ext}`,
  ),
];

/** Text no specific `regexes` pattern should match. */
const CANARY_MATCHES = ['nomad-canary-zz9q7', ''];

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
  const out = Object.create(null) as Table;
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
 * True when a gitleaks (Go) regex matches any canary, or is not a string or not
 * compilable in strict `u` mode, which refuses Go-only escapes like `\A` that
 * JS would otherwise read as literals. A leading `(?flags)` maps to JS flags.
 * @param pattern One `paths` or `regexes` entry.
 * @param canaries Inputs a specific pattern should not match.
 */
function isBroad(pattern: unknown, canaries: string[]): boolean {
  if (typeof pattern !== 'string') return true;
  const [prefix = '', flags = ''] = /^\(\?([imsU]+)\)/.exec(pattern) ?? [];
  const source = pattern.slice(prefix.length).replaceAll('(?P<', '(?<');
  let re: RegExp;
  try {
    re = new RegExp(source, `${flags.replace('U', '')}u`);
  } catch {
    return true;
  }
  return canaries.some((text) => re.test(text));
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
    // The parser's full message quotes the offending line, which may hold a secret.
    const { message, line, column } = err as TomlError;
    throw new NomadFatal(
      `.gitleaks.overlay.toml is not valid TOML (${message.split('\n')[0]}, line ${String(line)} column ${String(column)}).`,
    );
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
 * Every `[[rules]]` table in the overlay, with lowercased keys.
 * @param doc The parsed overlay with lowercased top-level keys.
 */
function ruleTables(doc: Table): Table[] {
  if (doc.rules === undefined) return [];
  if (!Array.isArray(doc.rules) || !doc.rules.every(isTable)) {
    throw new NomadFatal('.gitleaks.overlay.toml rules must be tables; use [[rules]] blocks.');
  }
  return doc.rules.map(lowerKeys);
}

/**
 * Reject a rule with no usable `id` or one that reuses a built-in gitleaks id,
 * which would replace that rule on every host. A new-id rule's own
 * `[[rules.allowlists]]` need no scope check: they can only weaken that rule.
 * @param rule One rule table with lowercased keys.
 */
function assertRuleIdNew(rule: Table): void {
  const { id } = rule;
  if (typeof id !== 'string' || id === '') {
    throw new NomadFatal(
      '.gitleaks.overlay.toml has a [[rules]] block that needs an `id` written as text, like id = "my-token".',
    );
  }
  if (GITLEAKS_DEFAULT_RULE_IDS.has(id.toLowerCase())) {
    throw new NomadFatal(
      `.gitleaks.overlay.toml rule "${id}" reuses a built-in gitleaks rule id, which would replace that rule on every host. Give your rule a new id.`,
    );
  }
}

/**
 * Reject an allowlist with a catch-all pattern, no `paths`, or matchers
 * without `condition = "AND"` (without AND, a path match alone allows a finding).
 * @param allowlist One allowlist table with lowercased keys.
 */
function assertAllowlistScoped(allowlist: Table): void {
  const regexes: unknown[] = [allowlist.regexes].flat().filter((p) => p !== undefined);
  const broadRegex = regexes.find((p) => isBroad(p, CANARY_MATCHES));
  if (broadRegex !== undefined) {
    throw new NomadFatal(
      `.gitleaks.overlay.toml allowlist regex ${JSON.stringify(broadRegex)} is a catch-all: it matches unrelated text, or nomad cannot check its regex syntax. Replace it with a specific, anchored pattern.`,
    );
  }
  if (!Array.isArray(allowlist.paths) || allowlist.paths.length === 0) {
    throw new NomadFatal(
      '.gitleaks.overlay.toml allowlist must be path-scoped: every [[allowlists]] block needs a `paths` entry so it cannot suppress findings repo-wide. Anchor `paths` to the files you intend to allow (e.g. shared/projects/<logical>/...jsonl).',
    );
  }
  const broad: unknown = allowlist.paths.find((p) => isBroad(p, CANARY_PATHS));
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
 * only path-scoped allowlists and new rule ids. Returns whether it uses a legacy `[allowlist]`
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
  for (const rule of ruleTables(doc)) assertRuleIdNew(rule);
  return { legacy: doc.allowlist !== undefined };
}

/**
 * The overlay without its global allowlist blocks: the legacy `[allowlist]` table
 * and every `[[allowlists]]` entry lacking a non-empty `targetRules`. A global
 * block makes single-file detect skip the whole file on a path match, so there it
 * can only hide findings. Returns `overlayBody` unchanged when nothing is dropped.
 * @param overlayBody An overlay that already passed `assertOverlaySafe`.
 */
export function stripGlobalAllowlists(overlayBody: string): string {
  const { allowlist, allowlists, ...rest } = parseOverlay(overlayBody);
  const blocks = [allowlists].flat().filter(isTable);
  const kept = blocks.filter((b) => [lowerKeys(b).targetrules].flat().some(Boolean));
  if (allowlist === undefined && kept.length === blocks.length) return overlayBody;
  return stringify(kept.length > 0 ? { ...rest, allowlists: kept } : rest);
}
