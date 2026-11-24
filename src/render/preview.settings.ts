import { existsSync } from 'node:fs';

import { HOST } from '../core/config.ts';
import { diffLinesToUnified } from './diff-lines.ts';
import { stripGsdHookEntries } from '../sync/hooks-filter.ts';
import { addItem, section } from './output-tree.ts';
import { escapeUnsafe } from '../sync/settings-classify.ts';
import {
  blockedSettingsKeys,
  removedSettingsKeys,
  settingsBlockedMessage,
  settingsRemovedMessage,
  type WrittenSettings,
} from '../sync/settings-guard.ts';
import { deepMerge, readJson, sortKeysDeep } from '../core/utils.json.ts';

/**
 * Note emitted when the only settings.json delta is key relocation: the raw
 * stringifications differ but their canonical (sorted-key) forms are equal.
 */
const CANONICAL_ORDER_NOTE =
  'settings.json will be rewritten in canonical key order; no value changes';

/** `text` with unsafe characters escaped line by line, keeping its line breaks. */
function escapeLines(text: string): string {
  return text.split('\n').map(escapeUnsafe).join('\n');
}

/**
 * LCS line diff for two pre-stringified JSON documents via jsdiff. Returns a
 * unified-diff style string: the two literal header lines
 * `--- ~/.claude/settings.json` and `+++ would write`, followed by body lines
 * where unchanged lines are prefixed with a space, removed lines with `-`
 * (red), and added lines with `+` (green). Coloring routes through `color.ts`
 * so `NO_COLOR` / non-TTY environments degrade to literal prefixes with no
 * ANSI escape sequences.
 *
 * Returns the empty string when inputs are byte-identical so the caller can
 * suppress the section. jsdiff `diffLines` aligns on the longest common
 * subsequence, so a mid-document insertion does not cascade false `-`/`+`
 * pairs for the unchanged tail.
 */
export function diffJsonStrings(currentJsonText: string, newJsonText: string): string {
  if (currentJsonText === newJsonText) return '';
  const lines: string[] = [
    '--- ~/.claude/settings.json',
    '+++ would write',
    ...diffLinesToUnified(escapeLines(currentJsonText), escapeLines(newJsonText)),
  ];
  return lines.join('\n');
}

/**
 * Read JSON from `path` returning the parsed object, or `null` on any
 * filesystem or parse failure. Used by previewSettings's tolerant read so a
 * malformed settings.json on a fresh-clone host does not abort the preview.
 * Valid JSON that is not a plain object (null, an array, a primitive) is also
 * `null`, matching how the wet path's `readExistingSettings` treats it.
 *
 * @param path - Absolute path of the JSON file.
 * @returns The parsed object, or `null` when absent, unreadable, or not an object.
 */
function readJsonOrNull(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = readJson<unknown>(path);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Compute the settings.json diff and any edge-case notes without logging.
 * Returns `{ diff, notes }` where `diff` is the unified diff string (`''`
 * when no changes) and `notes` holds human-readable skip/warning messages:
 *   - `'section skipped (base or current missing)'` when base is absent
 *   - `'malformed hosts/<HOST>.json; skipping diff'` for a bad host file (the
 *     wet pull cannot read it either, so no diff or refusal is computed)
 *   - `'malformed; skipping diff'` when current settings.json is unreadable
 *   - the shared `settingsBlockedMessage` when a live top-level key would be
 *     a promotable ahead-drift key a wet pull would refuse to overwrite, or
 *     the live file adds a hook entry under a `hooks` key the merge also
 *     carries
 *
 * When `diff` is `''` and `notes` is empty, the settings section is omitted
 * by the caller.
 *
 * Both sides have gsd-owned hook entries stripped (via `stripGsdHookEntries`)
 * before comparison so gsd's per-session hook self-heal churn never renders as a
 * phantom hooks delta, matching what `regenerateSettings` writes and mirroring
 * `classifySettingsDrift`. Genuine, non-gsd settings changes still surface.
 *
 * Both sides are canonicalized via `sortKeysDeep` before diffing so a pure key
 * relocation collapses to an empty diff instead of a removed-then-readded
 * cascade; when that happens the `CANONICAL_ORDER_NOTE` is appended so the user
 * still sees that settings.json will be rewritten in sorted-key order.
 * Display-only: the write path (`regenerateSettings`) is untouched.
 *
 * Before diffing, classifies via `blockedSettingsKeys` (the same leaf and
 * inputs `regenerateSettings` uses, including `preMerged`); a non-empty result
 * returns `diff: ''` plus `settingsBlockedMessage` instead of a diff that
 * would never apply. Sets no exit code: a dry run mutates nothing.
 *
 * Exported for direct unit testing without the full computePreview harness.
 *
 * @param basePath - Path to `shared/settings.base.json`.
 * @param hostPath - Path to `hosts/<HOST>.json`.
 * @param settingsPath - Path to the live `~/.claude/settings.json`.
 * @param preMerged - The merge at the pre-pull HEAD (`preRebaseSettingsMerge`).
 * @param written - The written-settings record; see `blockedSettingsKeys`.
 * @param writtenHookIds - Hashes of each hook entry's content from the last write.
 * @param writtenEntryIds - Hashes of each nested entry from the last write.
 * @returns The unified diff (`''` for none) and any notes.
 */
export function previewSettings(
  basePath: string,
  hostPath: string,
  settingsPath: string,
  preMerged: Record<string, unknown> = {},
  written: WrittenSettings | null = null,
  writtenHookIds: ReadonlySet<string> = new Set(),
  writtenEntryIds: ReadonlySet<string> = new Set(),
): { diff: string; notes: string[] } {
  const base = readJsonOrNull(basePath);
  if (base === null) {
    return { diff: '', notes: ['section skipped (base or current missing)'] };
  }
  const hostOverrides = readJsonOrNull(hostPath);
  // The wet pull cannot read a malformed host file either, so a diff or refusal
  // computed from base alone would describe a write that never happens.
  if (hostOverrides === null && existsSync(hostPath)) {
    return { diff: '', notes: [`malformed hosts/${HOST}.json; skipping diff`] };
  }
  const rawMerged = deepMerge(base, hostOverrides ?? {});
  const merged = stripGsdHookEntries(rawMerged);
  const current = readJsonOrNull(settingsPath);
  if (current === null && existsSync(settingsPath)) {
    return { diff: '', notes: ['malformed; skipping diff'] };
  }
  // Strip gsd-owned hook entries from both sides so gsd's per-session self-heal
  // churn never surfaces as a phantom hooks delta. regenerateSettings already
  // strips them on write, so this also aligns the preview RHS with reality.
  // Mirrors classifySettingsDrift; genuine non-gsd changes still survive.
  const strippedCurrent = stripGsdHookEntries(current ?? {});

  // Classify the same two objects regenerateSettings classifies (unstripped
  // merge, raw current), so this preview cannot disagree with the wet path.
  const blocked = blockedSettingsKeys(
    rawMerged,
    current ?? {},
    preMerged,
    written,
    writtenHookIds,
    writtenEntryIds,
  );
  if (blocked.length > 0) {
    return { diff: '', notes: [settingsBlockedMessage(blocked, 'would be left unchanged')] };
  }

  const rawEqual = JSON.stringify(strippedCurrent, null, 2) === JSON.stringify(merged, null, 2);
  const diff = diffJsonStrings(
    JSON.stringify(sortKeysDeep(strippedCurrent), null, 2),
    JSON.stringify(sortKeysDeep(merged), null, 2),
  );
  const notes = diff === '' && !rawEqual ? [CANONICAL_ORDER_NOTE] : [];
  const removed = removedSettingsKeys(
    rawMerged,
    current ?? {},
    preMerged,
    written,
    writtenHookIds,
    writtenEntryIds,
  );
  if (removed.length > 0) notes.push(settingsRemovedMessage(removed));
  return { diff, notes };
}

/**
 * Build the settings.json raw DoctorSection from a previewSettings result.
 * Returns a section with items when there is a diff or notes to show;
 * returns an empty-items section (skipped by renderTree) when both are absent.
 */
export function buildSettingsSectionForPreview(result: { diff: string; notes: string[] }) {
  const s = section('settings.json', true);
  if (result.diff !== '') {
    for (const line of result.diff.split('\n')) {
      addItem(s, line);
    }
  }
  for (const note of result.notes) {
    addItem(s, `note: ${note}`);
  }
  return s;
}
