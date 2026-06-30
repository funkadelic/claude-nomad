import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { claudeHome, HOST } from './config.ts';
import {
  classifySettingsDrift,
  describeSettings,
  partitionByCaptureExclusion,
} from './commands.capture-settings.core.ts';
import { baseHasGsdHookEntries, stripGsdHookEntries } from './hooks-filter.ts';
import { warn } from './utils.ts';
import { backupRepoWrite, freshBackupTs, writeJsonAtomic } from './utils.fs.ts';
import { deepMerge, readJson } from './utils.json.ts';

/**
 * Idempotent gsd-hook strip for the push write-path. Reads
 * `shared/settings.base.json`, applies `stripGsdHookEntries`, and on a real
 * change backs up via `backupRepoWrite` then writes atomically via
 * `writeJsonAtomic`. If the stripped result deep-equals the original (no gsd
 * entries present) the function returns without writing (no backup, no mtime
 * change). Best-effort: a missing or unparseable base is silently skipped.
 *
 * Must only be called on the REAL-push path (!dryRun). The function is
 * push-only by design: pull stays non-destructive per Phase 50 precedent.
 *
 * @param repo - Resolved repo root path for this invocation.
 * @param backup - Resolved backup root path for this invocation.
 */
export function stripGsdHooksFromBase(repo: string, backup: string): void {
  const basePath = join(repo, 'shared', 'settings.base.json');
  if (!existsSync(basePath)) return;
  let base: Record<string, unknown>;
  try {
    base = readJson<Record<string, unknown>>(basePath);
  } catch {
    return; // unparseable: skip silently (best-effort)
  }
  // Use the single shared predicate so an empty hooks: {} scaffold is NOT treated
  // as dirty (no gsd entries present means nothing to strip).
  if (!baseHasGsdHookEntries(base)) return;
  const stripped = stripGsdHookEntries(base);
  const ts = freshBackupTs(backup);
  backupRepoWrite(basePath, ts, repo);
  writeJsonAtomic(basePath, stripped);
}

/**
 * Read-only ahead-drift check for the push flow. Loads the repo's base +
 * host settings, computes the expected merge, and compares it against the live
 * `~/.claude/settings.json`. When the live file has keys not present in the
 * merge (the host is AHEAD), emits one `warn` line naming the local-only keys
 * and pointing at `nomad capture-settings`.
 *
 * Only keys capture would actually promote are reported: credential- and
 * secret-bearing keys (`CAPTURE_EXCLUDED_KEYS`) are filtered out, so the warning
 * neither advises an action that would no-op nor names a secret-bearing key.
 *
 * Best-effort and tolerant: any missing file or parse error is a silent skip.
 * Never mutates anything; never sets `process.exitCode`.
 *
 * @param repo - Resolved repo root path for this invocation.
 */
export function reportSettingsAheadDrift(repo: string): void {
  const basePath = join(repo, 'shared', 'settings.base.json');
  if (!existsSync(basePath)) return;
  const settingsPath = join(claudeHome(), 'settings.json');
  if (!existsSync(settingsPath)) return;
  try {
    const base = readJson<Record<string, unknown>>(basePath);
    const hostPath = join(repo, 'hosts', `${HOST}.json`);
    const overrides = existsSync(hostPath) ? readJson<Record<string, unknown>>(hostPath) : {};
    const merged = deepMerge(base, overrides);
    const settings = readJson<Record<string, unknown>>(settingsPath);
    const { ahead } = classifySettingsDrift(merged, settings);
    const { promotable } = partitionByCaptureExclusion(ahead);
    if (promotable.length === 0) return;
    const { phrase, pronoun, verb } = describeSettings(promotable);
    warn(
      `your settings.json has ${phrase} that ${verb} not yet in the repo; ` +
        `run 'nomad capture-settings' to save ${pronoun} (or 'nomad capture-settings --host' for host-specific values).`,
    );
  } catch {
    // Malformed JSON or unreadable file: skip silently (best-effort).
  }
}
