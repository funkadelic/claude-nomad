import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { dim, green, infoGlyph, okGlyph, warnGlyph, yellow } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { claudeHome, HOST, repoHome } from './config.ts';
import { deepMerge } from './utils.json.ts';

/**
 * Drift check for `nomad doctor`: recomputes `deepMerge(base, host)` and
 * deep-compares it against `~/.claude/settings.json`, surfacing the
 * external-clobber failure mode where a tool (e.g. Claude Code 2.1.167) silently
 * overwrites settings.json with only a subset of keys.
 *
 * Exports:
 * - `diffMergedSettings`: pure comparator (no fs, no side effects).
 * - `reportSettingsDriftCheck`: doctor reporter that reads files and emits rows.
 */

// ---------------------------------------------------------------------------
// Deep-equality helpers
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
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
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
// Pure comparator
// ---------------------------------------------------------------------------

/** Result shape from `diffMergedSettings`. */
export type SettingsDiff = {
  /** Keys present in merged but absent from settings (value-changed keys go to `changed`). */
  missing: string[];
  /** Keys present in both merged and settings with deep-different values. */
  changed: string[];
  /** Keys present in settings but absent from merged (local-only state). */
  extra: string[];
};

/**
 * Pure comparator. Partitions top-level keys of `merged` vs `settings` into
 * three buckets: `missing` (merged key absent from settings), `changed` (key
 * in both with deep-different value), and `extra` (settings key absent from
 * merged). Each bucket is sorted with `localeCompare(_, 'en')` for stable output.
 *
 * No filesystem access. No side effects.
 *
 * @param merged - Recomputed `deepMerge(base, host)` object.
 * @param settings - Parsed `~/.claude/settings.json` object.
 * @returns Classification of key-level drift.
 */
export function diffMergedSettings(
  merged: Record<string, unknown>,
  settings: Record<string, unknown>,
): SettingsDiff {
  const missing: string[] = [];
  const changed: string[] = [];
  const extra: string[] = [];
  const settingsKeys = new Set(Object.keys(settings));

  for (const key of Object.keys(merged)) {
    if (!settingsKeys.has(key)) {
      missing.push(key);
    } else if (!deepEqual(merged[key], settings[key])) {
      changed.push(key);
    }
  }

  const mergedKeys = new Set(Object.keys(merged));
  for (const key of Object.keys(settings)) {
    if (!mergedKeys.has(key)) extra.push(key);
  }

  const collator = (a: string, b: string): number => a.localeCompare(b, 'en');
  return {
    missing: missing.sort(collator),
    changed: changed.sort(collator),
    extra: extra.sort(collator),
  };
}

// ---------------------------------------------------------------------------
// Tolerant JSON parse helpers (inline, never sets exitCode)
// ---------------------------------------------------------------------------

/**
 * Tolerantly read and parse a JSON file. Returns null on any error (ENOENT,
 * permission denied, malformed JSON). Never throws, never sets exitCode.
 *
 * @param filePath - Absolute path to read.
 * @returns Parsed value or null on failure.
 */
function tryReadJson(filePath: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

/**
 * Append the settings merge-drift check result to the supplied section. Reads
 * `shared/settings.base.json`, `hosts/<HOST>.json` (optional), and
 * `~/.claude/settings.json`, recomputes the merge, and emits drift rows.
 *
 * Outcomes:
 * - `ℹ︎` skip when `settings.json` is absent, or `settings.base.json` is
 *   missing or present-but-unparseable (distinct wording per case).
 * - `⚠︎` WARN when `hosts/<HOST>.json` exists but is unparseable: a real
 *   `nomad pull` would die on that file, so the check must not report a
 *   base-only merge as healthy.
 * - `⚠︎` WARN when merged keys are absent from settings (external clobber).
 * - `⚠︎` WARN when merged keys are present but value-changed.
 * - `ℹ︎` info when settings has extra local-only keys (promotion candidates).
 *   Suppressed when no host file exists: `reportHostOverrides` already FAILs
 *   on the same unbased keys in that case, and a softer info row about the
 *   identical keys would contradict it.
 * - `✓` ok when settings matches the merge exactly.
 *
 * Never sets `process.exitCode`. Never throws.
 *
 * @param section - The doctor section to append items to.
 */
export function reportSettingsDriftCheck(section: DoctorSection): void {
  const claude = claudeHome();
  const repo = repoHome();
  const host = HOST;

  const settingsPath = join(claude, 'settings.json');
  const basePath = join(repo, 'shared', 'settings.base.json');
  const hostPath = join(repo, 'hosts', `${host}.json`);

  if (!existsSync(settingsPath)) {
    addItem(section, `${dim(infoGlyph)} no ~/.claude/settings.json; skipping merge-drift check`);
    return;
  }

  if (!existsSync(basePath)) {
    addItem(
      section,
      `${dim(infoGlyph)} shared/settings.base.json missing; skipping merge-drift check`,
    );
    return;
  }

  const base = tryReadJson(basePath);
  if (base === null) {
    // Present but unparseable: distinct from the absent case above so the
    // operator is not sent looking for a missing file (loadBaseSettings FAILs
    // on the same file in this run; this row must agree it is malformed).
    addItem(
      section,
      `${dim(infoGlyph)} shared/settings.base.json unparseable; skipping merge-drift check`,
    );
    return;
  }

  const settings = tryReadJson(settingsPath);
  if (settings === null) {
    // Malformed settings.json: silent skip (no row), no exitCode mutation.
    return;
  }

  const hostExists = existsSync(hostPath);
  const hostObj = hostExists ? tryReadJson(hostPath) : null;
  if (hostExists && hostObj === null) {
    // Present but unparseable: regenerateSettings reads this file without a
    // guard, so a real 'nomad pull' would die here. Reporting a base-only
    // merge as healthy would be a false-clean verdict; warn instead.
    addItem(
      section,
      `${yellow(warnGlyph)} hosts/${host}.json unparseable; 'nomad pull' will fail (fix the host file)`,
    );
    return;
  }
  const merged = deepMerge(base, hostObj ?? {});

  const { missing, changed, extra } = diffMergedSettings(merged, settings);

  emitDriftRows(section, missing, changed, extra, host, hostExists);
}

/**
 * Emit the drift rows for each category. Extracted to keep `reportSettingsDriftCheck`
 * under the cognitive-complexity gate.
 *
 * The extra-keys info row is gated on `hostFileExists`: with no host file,
 * `reportHostOverrides` already FAILs on the same unbased keys in the same
 * Settings section, and a softer "promotion candidates" row about identical
 * keys would contradict that verdict. The ok row is not emitted in that case
 * either (extras exist, so settings does not match the merge exactly).
 *
 * @param section - Doctor section to append to.
 * @param missing - Keys in merged absent from settings.
 * @param changed - Keys in both with different values.
 * @param extra - Keys in settings absent from merged.
 * @param host - Current host identifier for the promotion-candidate hint.
 * @param hostFileExists - Whether `hosts/<HOST>.json` exists (gates the extra-keys row).
 */
function emitDriftRows(
  section: DoctorSection,
  missing: string[],
  changed: string[],
  extra: string[],
  host: string,
  hostFileExists: boolean,
): void {
  if (missing.length > 0) {
    addItem(
      section,
      `${yellow(warnGlyph)} settings.json drift: merged keys missing locally: ${missing.join(', ')} (external writer clobbered settings.json; run 'nomad pull')`,
    );
  }
  if (changed.length > 0) {
    addItem(
      section,
      `${yellow(warnGlyph)} settings.json drift: merged keys with changed values: ${changed.join(', ')} (run 'nomad pull')`,
    );
  }
  if (extra.length > 0 && hostFileExists) {
    addItem(
      section,
      `${dim(infoGlyph)} settings.json has ${extra.length} local-only key(s) not in base+host merge: ${extra.join(', ')} (promotion candidates for shared/settings.base.json or hosts/${host}.json)`,
    );
  }
  if (missing.length === 0 && changed.length === 0 && extra.length === 0) {
    addItem(section, `${green(okGlyph)} settings.json matches base+host merge`);
  }
}
