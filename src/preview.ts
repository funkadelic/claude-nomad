import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { claudeHome, repoHome, HOST, type PathMap } from './config.ts';
import { diffLinesToUnified } from './diff-lines.ts';
import { stripGsdHookEntries } from './hooks-filter.ts';
import { type LinkPreviewEvent, applySharedLinks } from './links.ts';
import { addItem, renderTree, section } from './output-tree.ts';
import { type RemapPullPreviewEvent, remapPull, scanLocalOnly } from './remap.ts';
import { summaryRow } from './summary.ts';
import { deepMerge, readJson, sortKeysDeep } from './utils.json.ts';

/**
 * Note emitted when the only settings.json delta is key relocation: the raw
 * stringifications differ but their canonical (sorted-key) forms are equal.
 */
const CANONICAL_ORDER_NOTE =
  'settings.json will be rewritten in canonical key order; no value changes';

/** Verb variants that appear in the Summary row of the preview tree. */
type PreviewVerb = 'pull' | 'diff';

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
    ...diffLinesToUnified(currentJsonText, newJsonText),
  ];
  return lines.join('\n');
}

/**
 * Read JSON from `path` returning the parsed object, or `null` on any
 * filesystem or parse failure. Used by previewSettings's tolerant read so a
 * malformed settings.json on a fresh-clone host does not abort the preview.
 */
function readJsonOrNull(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return readJson<Record<string, unknown>>(path);
  } catch {
    return null;
  }
}

/**
 * Compute the settings.json diff and any edge-case notes without logging.
 * Returns `{ diff, notes }` where `diff` is the unified diff string (`''`
 * when no changes) and `notes` holds human-readable skip/warning messages:
 *   - `'section skipped (base or current missing)'` when base is absent
 *   - `'malformed hosts/<HOST>.json; ignoring overrides'` for a bad host file
 *   - `'malformed; skipping diff'` when current settings.json is unreadable
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
 * Exported for direct unit testing without the full computePreview harness.
 */
export function previewSettings(
  basePath: string,
  hostPath: string,
  settingsPath: string,
): { diff: string; notes: string[] } {
  const base = readJsonOrNull(basePath);
  if (base === null) {
    return { diff: '', notes: ['section skipped (base or current missing)'] };
  }
  const notes: string[] = [];
  const hostOverrides = readJsonOrNull(hostPath);
  if (hostOverrides === null && existsSync(hostPath)) {
    notes.push(`malformed hosts/${HOST}.json; ignoring overrides`);
  }
  const merged = stripGsdHookEntries(deepMerge(base, hostOverrides ?? {}));
  const current = readJsonOrNull(settingsPath);
  if (current === null && existsSync(settingsPath)) {
    return { diff: '', notes: [...notes, 'malformed; skipping diff'] };
  }
  // Strip gsd-owned hook entries from both sides so gsd's per-session self-heal
  // churn never surfaces as a phantom hooks delta. regenerateSettings already
  // strips them on write, so this also aligns the preview RHS with reality.
  // Mirrors classifySettingsDrift; genuine non-gsd changes still survive.
  const strippedCurrent = stripGsdHookEntries(current ?? {});
  const rawEqual = JSON.stringify(strippedCurrent, null, 2) === JSON.stringify(merged, null, 2);
  const diff = diffJsonStrings(
    JSON.stringify(sortKeysDeep(strippedCurrent), null, 2),
    JSON.stringify(sortKeysDeep(merged), null, 2),
  );
  if (diff === '' && !rawEqual) notes.push(CANONICAL_ORDER_NOTE);
  return { diff, notes };
}

/**
 * Format a link preview event as a Symlinks section row.
 * Examples:
 *   `create    ~/.claude/CLAUDE.md -> /home/user/claude-nomad/shared/CLAUDE.md`
 *   `auto-move ~/.claude/CLAUDE.md -> backup/20260516-000000/CLAUDE.md`
 */
function formatLinkRow(e: LinkPreviewEvent): string {
  return `${e.kind}  ${e.from} -> ${e.to}`;
}

/**
 * Format a remap pull preview event as a Sessions section row. An `overwrite`
 * event renders `overwrite  <dst> (from <src>)`; a `note` event (e.g. nothing
 * to remap) renders its text verbatim. Either way the row is glyph-free.
 *
 * @param e The structured event emitted by `remapPull` under dry-run.
 * @returns The rendered Sessions row text.
 */
function formatSessionRow(e: RemapPullPreviewEvent): string {
  return e.kind === 'overwrite' ? `overwrite  ${e.dst} (from ${e.src})` : e.text;
}

/**
 * Build the settings.json raw DoctorSection from a previewSettings result.
 * Returns a section with items when there is a diff or notes to show;
 * returns an empty-items section (skipped by renderTree) when both are absent.
 */
function buildSettingsSectionForPreview(result: { diff: string; notes: string[] }) {
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

/**
 * Orchestrate the dry-run preview across all three sync modalities:
 * symlinks (via applySharedLinks onPreview), settings.json (via deepMerge +
 * diffJsonStrings), and projects (via remapPull onPreview). Renders a
 * glyph-free doctor-style grouped tree:
 *
 *   `would pull on host=<HOST> (dry-run; no mutation)`
 *   (blank line)
 *   Symlinks
 *     create  <from> -> <to>
 *     ...
 *   settings.json        <- RAW section, omitted when no changes
 *     --- ~/.claude/settings.json
 *     +++ would write
 *     ...
 *   Sessions
 *     overwrite  <dst> (from <src>)
 *     <N> local-only present, not in repo (push to reconcile)   <- when N > 0
 *     ...
 *   Summary
 *     <summaryRow(verb, unmapped, 0, 0, localOnly)>
 *
 * Returns `{ unmapped, collisions, localOnly }` aggregated from remapPull and
 * `scanLocalOnly`. `collisions` is always 0 in this slice.
 *
 * The local-only row surfaces retained-but-unpushed session leaf files (D-06):
 * with retain-merge (`overlaySessionDir`) these entries survive a pull, so the
 * preview reframes a misleading `clean` into an honest count. The scan is
 * read-only (no `cpSync`/`rmSync`/`mkdirSync`), so the dry-run/diff zero-mutation
 * contract holds; the row is plain text (no glyph) to keep the diff tree
 * glyph-free. Both `pull --dry-run` and `nomad diff` route through this single
 * function, so the count is identical on both surfaces (D-07).
 *
 * Tolerant by design: missing `shared/settings.base.json` and malformed
 * `~/.claude/settings.json` both produce a note in the settings section and
 * continue rather than throw. This supports `cmdDiff`'s offline-safe contract.
 *
 * @param ts - backup timestamp (used by applySharedLinks/remapPull for log
 *   phrasing; no backup dir is created under dryRun).
 * @param map - parsed path-map.json; callers fall back to `{ projects: {} }`
 *   when the file is absent.
 * @param verb - 'diff' for cmdDiff, 'pull' for pull --dry-run. Defaults to
 *   'pull' so existing callers compile unchanged.
 */
export function computePreview(
  ts: string,
  map: PathMap,
  verb: PreviewVerb = 'pull',
): { unmapped: number; collisions: number; localOnly: number } {
  const repo = repoHome();
  const claude = claudeHome();
  console.log(`would pull on host=${HOST} (dry-run; no mutation)`);
  console.log('');

  // Symlinks section.
  const links = section('Symlinks');
  applySharedLinks(ts, map, {
    dryRun: true,
    onPreview: (e) => addItem(links, formatLinkRow(e)),
  });

  // settings.json section (raw, omitted when diff='' and no notes).
  const settingsResult = previewSettings(
    join(repo, 'shared', 'settings.base.json'),
    join(repo, 'hosts', `${HOST}.json`),
    join(claude, 'settings.json'),
  );
  const settingsSection = buildSettingsSectionForPreview(settingsResult);

  // Sessions section.
  const sessions = section('Sessions');
  const remapResult = remapPull(ts, {
    dryRun: true,
    onPreview: (e) => addItem(sessions, formatSessionRow(e)),
  });
  // Honest local-only count (D-06): read-only scan of retained-but-unpushed
  // session leaf files. Rendered as a plain-text (glyph-free) Sessions row only
  // when non-zero, so a clean tree still reads 'clean'.
  const localOnly = scanLocalOnly();
  if (localOnly > 0) {
    addItem(sessions, `${localOnly} local-only present, not in repo (push to reconcile)`);
  }

  // Summary section.
  const summary = section('Summary');
  addItem(summary, summaryRow(verb, remapResult.unmapped, 0, 0, localOnly));

  renderTree([links, settingsSection, sessions, summary]);

  return { unmapped: remapResult.unmapped, collisions: 0, localOnly };
}
