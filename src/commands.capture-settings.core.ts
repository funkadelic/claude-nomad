/**
 * Pure, filesystem-free core for direction-aware settings drift detection and
 * the capture-settings command.
 *
 * Exports:
 * - `SettingsDrift`: direction-named partition of settings key divergence.
 * - `classifySettingsDrift`: pure classifier, no fs.
 * - `buildCaptureSubset`: key/value subset to promote from live settings into base or host.
 * - `normalizeNodePathsDeep`: rewrite absolute node launcher paths to bare `node`.
 * - `CAPTURE_EXCLUDED_KEYS`: sensitive keys never eligible for capture.
 */

import { stripGsdHookEntries } from './hooks-filter.ts';

// ---------------------------------------------------------------------------
// Deep-equality helpers (dep-free). This module owns the single drift
// classifier; the doctor settings-drift check adapts `classifySettingsDrift`
// rather than carrying its own copy.
// ---------------------------------------------------------------------------

/**
 * Compare two arrays element-by-element, recursing into each element.
 *
 * @param a - First array.
 * @param b - Second array.
 * @returns True when arrays have equal length and pairwise-equal elements.
 */
function arraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!deepEqual(a[i], b[i])) return false;
  }
  return true;
}

/**
 * Compare two plain objects by key-set then per-key recursion.
 *
 * @param a - First object.
 * @param b - Second object.
 * @returns True when both objects have the same keys and pairwise-equal values.
 */
function objectsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.hasOwn(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Dep-free deep equality: scalars and null use strict equality; arrays compare
 * length then element-wise recursively; plain objects compare key-set then
 * recurse per key; mismatched shapes are not equal.
 *
 * @param a - First value.
 * @param b - Second value.
 * @returns True when `a` and `b` are deeply equal.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) return arraysEqual(a, b);
  if (Array.isArray(a) || Array.isArray(b)) return false;
  if (typeof a === 'object' && typeof b === 'object') {
    return objectsEqual(a as Record<string, unknown>, b as Record<string, unknown>);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Direction-aware drift type
// ---------------------------------------------------------------------------

/**
 * Direction-named partition of top-level key drift between a merged settings
 * object and the live `~/.claude/settings.json`.
 *
 * - `behind`: keys in merged but absent from live settings. The local host is
 *   BEHIND the repo state (an external writer clobbered settings.json). Fix:
 *   `nomad pull`.
 * - `ahead`: keys in live settings but absent from merged. The local host is
 *   AHEAD (legitimate local additions not yet in the repo). Fix: `nomad
 *   capture-settings`.
 * - `changed`: keys in both with deep-different values.
 */
export type SettingsDrift = {
  /** Keys present in merged but absent from live settings. */
  behind: string[];
  /** Keys present in live settings but absent from merged. */
  ahead: string[];
  /** Keys in both with deep-different values. */
  changed: string[];
};

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Pure direction-aware drift classifier. Partitions top-level keys of `merged`
 * vs `settings` into `behind`, `ahead`, and `changed` buckets. Each bucket is
 * sorted with `localeCompare(_, 'en')` for stable output.
 *
 * The `changed` comparison normalizes node launcher paths on both sides first
 * (`normalizeNodePathsDeep`), so a key that differs only by a host-specific
 * absolute launcher (`/.../bin/node`) versus the canonical bare `node` (the
 * churn an external installer writes) is NOT reported as changed. A key still
 * lands in `changed` when its values differ for any reason other than that
 * launcher-path normalization. `behind`/`ahead` are presence-based and so are
 * unaffected by normalization.
 *
 * gsd-owned hook entries are stripped from both `merged` and `settings` before
 * classification (D-05). A key that differs only by gsd-installed hook entries
 * (permanent self-heal churn) is not reported as behind/ahead/changed. A
 * genuine user-authored hook entry is still classified correctly.
 *
 * No filesystem access. No side effects.
 *
 * @param merged - Recomputed `deepMerge(base, host)` object.
 * @param settings - Parsed `~/.claude/settings.json` object.
 * @returns Direction-named key-level drift partition.
 */
export function classifySettingsDrift(
  merged: Record<string, unknown>,
  settings: Record<string, unknown>,
): SettingsDrift {
  // Strip gsd-owned hook entries from both sides before classification so that
  // a key that differs only by gsd-installed hooks (permanent self-heal churn)
  // is not reported as changed/behind/ahead. Layered on top of the existing
  // normalizeNodePathsDeep pass in the changed bucket below (D-05).
  const filteredMerged = stripGsdHookEntries(merged);
  const filteredSettings = stripGsdHookEntries(settings);

  const behind: string[] = [];
  const ahead: string[] = [];
  const changed: string[] = [];
  const settingsKeys = new Set(Object.keys(filteredSettings));

  for (const key of Object.keys(filteredMerged)) {
    if (!settingsKeys.has(key)) {
      behind.push(key);
    } else if (
      !deepEqual(
        normalizeNodePathsDeep(filteredMerged[key]),
        normalizeNodePathsDeep(filteredSettings[key]),
      )
    ) {
      changed.push(key);
    }
  }

  const mergedKeys = new Set(Object.keys(filteredMerged));
  for (const key of Object.keys(filteredSettings)) {
    if (!mergedKeys.has(key)) ahead.push(key);
  }

  const collator = (a: string, b: string): number => a.localeCompare(b, 'en');
  return {
    behind: behind.toSorted(collator),
    ahead: ahead.toSorted(collator),
    changed: changed.toSorted(collator),
  };
}

// ---------------------------------------------------------------------------
// Capture exclusion list
// ---------------------------------------------------------------------------

/**
 * Top-level `settings.json` keys that are never eligible for capture into the
 * shared repo. These are the credential- and secret-bearing keys of the Claude
 * Code settings schema: each either resolves to a secret (a key-returning helper
 * script) or commonly holds inline secrets (`env`, where `ANTHROPIC_API_KEY`,
 * `AWS_*`, and tokens live). Auto-promoting any of them would sync a credential
 * to every host, violating the capture invariant.
 *
 * This is deliberately a set of settings.json KEY names (e.g. `apiKeyHelper`),
 * NOT the file-name members of `ALWAYS_NEVER_SYNC` (e.g. `.credentials.json`):
 * the two namespaces never overlap, so guarding capture with the file-name set
 * would exclude nothing. `env` is excluded wholesale; a user who wants to share
 * non-secret env vars can hand-edit the base file.
 */
export const CAPTURE_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'otelHeadersHelper',
  'env',
]);

/**
 * Partition a key list into the keys capture would promote (`promotable`) and
 * the keys it refuses (`excluded`, members of `CAPTURE_EXCLUDED_KEYS`). Input
 * order is preserved in both outputs.
 *
 * Used by the doctor and push drift surfaces so their "run nomad
 * capture-settings" advice names only keys capture can actually promote, and
 * never names an excluded credential key (which would both mis-advise an action
 * that no-ops and disclose a secret-bearing key name).
 *
 * @param keys - Candidate key list (typically the `ahead` drift bucket).
 * @returns `{ promotable, excluded }` partition.
 */
export function partitionByCaptureExclusion(keys: string[]): {
  promotable: string[];
  excluded: string[];
} {
  const promotable: string[] = [];
  const excluded: string[] = [];
  for (const key of keys) {
    if (CAPTURE_EXCLUDED_KEYS.has(key)) excluded.push(key);
    else promotable.push(key);
  }
  return { promotable, excluded };
}

// ---------------------------------------------------------------------------
// Node-path normalizer
// ---------------------------------------------------------------------------

/**
 * Regex matching a string that is ENTIRELY an absolute launcher path ending in
 * `bin/node` (or Windows `bin\node`), with optional surrounding double quotes.
 * The leading `(?:[A-Za-z]:)?[\\/]` anchor requires a posix root (`/`), a Windows
 * backslash root, or a drive letter, so a relative command such as `./bin/node`
 * is left untouched (it is an intentional value, not a machine-specific absolute
 * launcher path). The `.*` interior crosses spaces, so a quoted path containing
 * spaces (e.g. `"C:\Program Files\nodejs\bin\node"`) is matched in this
 * whole-string form.
 */
const BIN_NODE_RE = /^"?(?:[A-Za-z]:)?[\\/](?:.*[\\/])?bin[\\/]node"?$/;

/**
 * Regex matching an absolute `bin/node` launcher as the LEADING token of a
 * command line (optionally double-quoted), followed by whitespace, e.g. the
 * `"/home/u/.nvm/.../bin/node"` in `"/home/u/.nvm/.../bin/node" "$HOME/x.js"`.
 * Path segments use `[^"\s]` so the match cannot run past the token into the
 * rest of the command. The whole-string form is handled by `BIN_NODE_RE`.
 */
const LEADING_BIN_NODE_RE = /^"?(?:[A-Za-z]:)?[\\/](?:[^"\s]*[\\/])?bin[\\/]node"?(?=\s)/;

/**
 * Rewrite an absolute node launcher path to the bare string `'node'`, both when
 * the whole string IS the launcher path and when it is the leading token of a
 * command line. The bare-`node` form is the canonical, host-portable launcher;
 * an absolute `/.../bin/node` is host-specific churn an external installer
 * writes. Recurses into nested objects and arrays so hook `command` values are
 * normalized throughout.
 *
 * - `/home/user/.nvm/versions/node/v20/bin/node` becomes `'node'`.
 * - `'/usr/bin/node' "$HOME/x.js"` becomes `'node "$HOME/x.js"'`.
 * - `'node'` (bare) and `'node --flag x'` stay unchanged.
 * - `'npx'` stays `'npx'`; `'bash "/x/bin/node.sh"'` stays unchanged.
 *
 * Known limits, all benign because the only effect of a miss is that a node-path
 * difference is reported as drift rather than silently normalized away:
 * - A launcher path with INTERNAL spaces (e.g. Windows `Program Files`) is
 *   normalized only in the whole-string form, not as the leading token of a
 *   longer command line (the leading-token matcher stops at the first space).
 *   An unquoted path with a space is not a valid shell command anyway.
 * - Two DIFFERENT absolute launchers (e.g. node-v18 vs node-v20 paths) both
 *   normalize to bare `node`, so a deliberately version-pinned launcher is
 *   treated as equal. This is intentional: bare `node` is the canonical form and
 *   nomad already normalizes launcher paths when capturing into the base.
 *
 * @param value - Any JSON-compatible value.
 * @returns The value with matching strings normalized.
 */
export function normalizeNodePathsDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    if (BIN_NODE_RE.test(value)) return 'node';
    const lead = LEADING_BIN_NODE_RE.exec(value);
    return lead ? 'node' + value.slice(lead[0].length) : value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeNodePathsDeep);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeNodePathsDeep(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Capture-subset builder
// ---------------------------------------------------------------------------

/** Options controlling `buildCaptureSubset` behaviour. */
export type CaptureSubsetOpts = {
  /**
   * When true, apply `normalizeNodePathsDeep` to each captured value so
   * absolute node launcher paths become bare `node` before writing into base.
   * Set to false when writing into a host file (path stays host-specific).
   */
  normalizeNodePath: boolean;
};

/**
 * Build the key/value subset to write into the shared repo (base or host file).
 *
 * Only the `ahead` keys (live settings keys absent from `merged`) are returned.
 * Merged keys and changed keys are excluded: capture promotes additions, never
 * overwrites base values.
 *
 * Secret keys in `CAPTURE_EXCLUDED_KEYS` are omitted regardless of direction so
 * a credential injected into live settings cannot ride into the shared repo.
 *
 * When `opts.normalizeNodePath` is true, each captured value passes through
 * `normalizeNodePathsDeep` so host-specific launcher paths cannot break other
 * hosts.
 *
 * @param merged - Recomputed `deepMerge(base, host)` object.
 * @param settings - Parsed `~/.claude/settings.json` object.
 * @param opts - Capture options.
 * @returns Subset of `settings` entries eligible for promotion.
 */
export function buildCaptureSubset(
  merged: Record<string, unknown>,
  settings: Record<string, unknown>,
  opts: CaptureSubsetOpts,
): Record<string, unknown> {
  const { ahead } = classifySettingsDrift(merged, settings);
  const out: Record<string, unknown> = {};
  for (const key of ahead) {
    if (CAPTURE_EXCLUDED_KEYS.has(key)) continue;
    const raw = settings[key];
    out[key] = opts.normalizeNodePath ? normalizeNodePathsDeep(raw) : raw;
  }
  return out;
}
