import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_HOME, HOST, REPO_HOME, type PathMap } from './config.ts';
import { diffLinesToUnified } from './diff-lines.ts';
import { applySharedLinks } from './links.ts';
import { remapPull } from './remap.ts';
import { log } from './utils.ts';
import { deepMerge, readJson } from './utils.json.ts';

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
 * filesystem or parse failure. Used by computePreview's tolerant settings
 * read so a malformed settings.json on a fresh-clone host does not abort
 * the preview surface.
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
 * Emit the settings.json section of the dry-run preview. Reads base, host
 * overrides, and current settings; logs a unified diff or a skip message.
 *
 * Extracted from `computePreview` to reduce cognitive complexity: the nested
 * base-null / malformed-host / malformed-current branches each add score.
 */
function previewSettings(basePath: string, hostPath: string, settingsPath: string): void {
  const base = readJsonOrNull(basePath);
  if (base === null) {
    log('settings.json: section skipped (base or current missing)');
    return;
  }
  // Tolerate a malformed hosts/<HOST>.json: log once and fall back to no overrides.
  const hostOverrides = readJsonOrNull(hostPath);
  if (hostOverrides === null && existsSync(hostPath)) {
    log(`settings.json: malformed hosts/${HOST}.json; ignoring overrides`);
  }
  const merged = deepMerge(base, hostOverrides ?? {});
  const current = readJsonOrNull(settingsPath);
  if (current === null && existsSync(settingsPath)) {
    log('settings.json: malformed; skipping diff');
    return;
  }
  const diff = diffJsonStrings(
    JSON.stringify(current ?? {}, null, 2),
    JSON.stringify(merged, null, 2),
  );
  if (diff === '') {
    log('settings.json: no changes');
  } else {
    log('settings.json:');
    for (const line of diff.split('\n')) log(line);
  }
}

/**
 * Orchestrate the dry-run preview across all three sync modalities:
 * symlinks (via applySharedLinks dry-run), settings.json (via deepMerge +
 * diffJsonStrings; we do NOT call regenerateSettings dry-run because that
 * emits a "would write" intent line that duplicates the unified diff
 * produced here), and projects (via remapPull dry-run).
 *
 * Returns `{ unmapped, collisions }` aggregated from remapPull. Collisions
 * is always 0 in this slice; a future slice wires path-encoding collision
 * detection through.
 *
 * Tolerant by design: missing `shared/settings.base.json` and malformed
 * `~/.claude/settings.json` both emit a single log line and continue rather
 * than throw. This supports `cmdDiff`'s offline-safe contract, where the
 * preview may run against a partially-scaffolded repo (e.g. right after a
 * fresh clone before `nomad init`).
 *
 * Settings diff output goes through `log()` so each line gets the info-prefixed
 * prefix, keeping output channels consistent across the three sections.
 *
 * @param map - parsed path-map.json; callers fall back to `{ projects: {} }`
 *   when the file is absent so the offline/fresh-clone contract holds.
 */
export function computePreview(ts: string, map: PathMap): { unmapped: number; collisions: number } {
  log(`would pull on host=${HOST} (dry-run; no mutation)`);

  // Symlinks: applySharedLinks emits its own would-create / would-auto-move
  // lines. dryRun:true is mandatory; a real call here would mutate disk.
  applySharedLinks(ts, map, { dryRun: true });

  previewSettings(
    join(REPO_HOME, 'shared', 'settings.base.json'),
    join(REPO_HOME, 'hosts', `${HOST}.json`),
    join(CLAUDE_HOME, 'settings.json'),
  );

  // Projects: remapPull emits its own would-overwrite lines and returns the
  // skipped count.
  const remapResult = remapPull(ts, { dryRun: true });
  return { unmapped: remapResult.unmapped, collisions: 0 };
}
