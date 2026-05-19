import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { green, red } from './color.ts';
import { CLAUDE_HOME, HOST, REPO_HOME } from './config.ts';
import { applySharedLinks } from './links.ts';
import { remapPull } from './remap.ts';
import { deepMerge, log, readJson } from './utils.ts';

/**
 * Minimal in-tree unified-diff helper for two pre-stringified JSON
 * documents. Walks the line arrays in parallel and emits a unified-diff
 * style output: unchanged lines prefixed with a space, removed lines with
 * `-` (red), added lines with `+` (green), plus at most three lines of
 * surrounding context per changed block. The implementation is intentionally
 * naive (no LCS); for two ~50-line settings JSON inputs the result is
 * acceptable even if not optimal.
 *
 * Returns the empty string when the inputs are byte-identical so the caller
 * can suppress the section. Picocolors handles `NO_COLOR` / `FORCE_COLOR`
 * detection, so the `red`/`green` wrappers degrade to identity in non-TTY
 * environments and the output stays literal `-` / `+` prefixed.
 *
 * The header line `--- ~/.claude/settings.json` / `+++ would write` is
 * literal; callers that want a different header can prepend their own.
 */
export function diffJsonStrings(currentJsonText: string, newJsonText: string): string {
  if (currentJsonText === newJsonText) return '';
  const a = currentJsonText.split('\n');
  const b = newJsonText.split('\n');
  const lines: string[] = [];
  lines.push('--- ~/.claude/settings.json');
  lines.push('+++ would write');

  // Walk both arrays in parallel. Lines that match index-wise are context;
  // others are emitted as -a / +b. A real unified-diff would compute the
  // longest common subsequence; this naive walk is good enough for two JSON
  // documents pretty-printed at the same indentation level.
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === bv) {
      if (av !== undefined) lines.push(` ${av}`);
      continue;
    }
    if (av !== undefined) lines.push(red(`-${av}`));
    if (bv !== undefined) lines.push(green(`+${bv}`));
  }
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
 * Settings diff output goes through `log()` so each line gets the `[nomad]`
 * prefix, keeping output channels consistent across the three sections.
 */
export function computePreview(ts: string): { unmapped: number; collisions: number } {
  log(`would pull on host=${HOST} (dry-run; no mutation)`);

  // Symlinks: applySharedLinks emits its own would-create / would-auto-move
  // lines. dryRun:true is mandatory; a real call here would mutate disk.
  applySharedLinks(ts, { dryRun: true });

  // Settings section: skip-with-log when base or current is missing. Per the
  // locked phrasing decision, the message text is fixed so cmdDiff users see
  // the same line regardless of which side is missing. Calling
  // regenerateSettings(ts, { dryRun: true }) would only emit a generic
  // "would write" intent line; we want the unified diff here, so we compute
  // it directly from base + host-override + current.
  const basePath = join(REPO_HOME, 'shared', 'settings.base.json');
  const hostPath = join(REPO_HOME, 'hosts', `${HOST}.json`);
  const settingsPath = join(CLAUDE_HOME, 'settings.json');
  const base = readJsonOrNull(basePath);
  if (base === null) {
    // Base is the load-bearing input here. Per the locked phrasing decision,
    // emit one canonical message and skip the diff. The current-side missing
    // case (no ~/.claude/settings.json) is handled below by treating current
    // as `{}` and producing a normal diff; only base-missing is fatal-ish.
    log('settings.json: section skipped (base or current missing)');
  } else {
    const overrides = existsSync(hostPath) ? readJson<Record<string, unknown>>(hostPath) : {};
    const merged = deepMerge(base, overrides);
    const current = readJsonOrNull(settingsPath);
    if (current === null && existsSync(settingsPath)) {
      log('settings.json: malformed; skipping diff');
    } else {
      const currentText = JSON.stringify(current ?? {}, null, 2);
      const mergedText = JSON.stringify(merged, null, 2);
      const diff = diffJsonStrings(currentText, mergedText);
      if (diff === '') {
        log('settings.json: no changes');
      } else {
        log('settings.json:');
        for (const line of diff.split('\n')) log(line);
      }
    }
  }

  // Projects: remapPull emits its own would-overwrite lines and returns the
  // skipped count.
  const remapResult = remapPull(ts, { dryRun: true });
  return { unmapped: remapResult.unmapped, collisions: 0 };
}
