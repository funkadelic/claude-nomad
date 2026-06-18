import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { dim, green, infoGlyph, okGlyph, warnGlyph, yellow } from './color.ts';
import { classifySettingsDrift } from './commands.capture-settings.core.ts';
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
 * Pure comparator in doctor's local vocabulary (`missing`/`changed`/`extra`).
 *
 * This is a thin adapter over `classifySettingsDrift` (the single shared
 * classifier in `commands.capture-settings.core.ts`): the core's `behind`
 * bucket is doctor's `missing`, and the core's `ahead` bucket is doctor's
 * `extra`. Keeping one classifier prevents the doctor and capture/push surfaces
 * from drifting apart; the rename preserves doctor's stable public shape and
 * sorted-bucket guarantee.
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
  const { behind, changed, ahead } = classifySettingsDrift(merged, settings);
  return { missing: behind, changed, extra: ahead };
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

  emitDriftRows(section, missing, changed, extra, hostExists);
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
 * @param hostFileExists - Whether `hosts/<HOST>.json` exists (gates the extra-keys row).
 */
function emitDriftRows(
  section: DoctorSection,
  missing: string[],
  changed: string[],
  extra: string[],
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
      `${dim(infoGlyph)} settings.json has ${extra.length} local-only key(s) not in base+host merge: ${extra.join(', ')} (run 'nomad capture-settings' to promote them into the repo)`,
    );
  }
  if (missing.length === 0 && changed.length === 0 && extra.length === 0) {
    addItem(section, `${green(okGlyph)} settings.json matches base+host merge`);
  }
}
