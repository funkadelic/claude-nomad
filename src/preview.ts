import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_HOME, HOST, REPO_HOME, type PathMap } from './config.ts';
import { diffLinesToUnified } from './diff-lines.ts';
import { type LinkPreviewEvent, applySharedLinks } from './links.ts';
import { addItem, renderTree, section } from './output-tree.ts';
import { type RemapPullPreviewEvent, remapPull } from './remap.ts';
import { summaryRow } from './summary.ts';
import { deepMerge, readJson } from './utils.json.ts';

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
 */
function previewSettings(
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
  const merged = deepMerge(base, hostOverrides ?? {});
  const current = readJsonOrNull(settingsPath);
  if (current === null && existsSync(settingsPath)) {
    return { diff: '', notes: [...notes, 'malformed; skipping diff'] };
  }
  const diff = diffJsonStrings(
    JSON.stringify(current ?? {}, null, 2),
    JSON.stringify(merged, null, 2),
  );
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
 * Format a remap pull preview event as a Sessions section row.
 * Shows the destination path basename (the encoded dir name).
 */
function formatOverwriteRow(e: RemapPullPreviewEvent): string {
  return `overwrite  ${e.dst} (from ${e.src})`;
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
 *     ...
 *   Summary
 *     <summaryRow(verb, unmapped)>
 *
 * Returns `{ unmapped, collisions }` aggregated from remapPull.
 * `collisions` is always 0 in this slice.
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
): { unmapped: number; collisions: number } {
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
    join(REPO_HOME, 'shared', 'settings.base.json'),
    join(REPO_HOME, 'hosts', `${HOST}.json`),
    join(CLAUDE_HOME, 'settings.json'),
  );
  const settingsSection = buildSettingsSectionForPreview(settingsResult);

  // Sessions section.
  const sessions = section('Sessions');
  const remapResult = remapPull(ts, {
    dryRun: true,
    onPreview: (e) => addItem(sessions, formatOverwriteRow(e)),
  });

  // Summary section.
  const summary = section('Summary');
  addItem(summary, summaryRow(verb, remapResult.unmapped));

  renderTree([links, settingsSection, sessions, summary]);

  return { unmapped: remapResult.unmapped, collisions: 0 };
}
