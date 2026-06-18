import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { backupBase, claudeHome, HOST, repoHome } from './config.ts';
import { buildCaptureSubset } from './commands.capture-settings.core.ts';
import { regenerateSettings } from './links.ts';
import { backupRepoWrite, freshBackupTs, writeJsonAtomic } from './utils.fs.ts';
import { deepMerge, readJson } from './utils.json.ts';
import { acquireLock, releaseLock } from './utils.lockfile.ts';
import { die, log, NomadFatal } from './utils.ts';

/** Options for the `nomad capture-settings` subcommand. */
export type CaptureSettingsOpts = {
  /** When true, write to `hosts/<HOST>.json` instead of `shared/settings.base.json`. */
  host: boolean;
  /** When true, print what would change without writing anything. */
  dryRun: boolean;
};

/**
 * Resolve the repo destination path and the current content of that file.
 *
 * @param repo - Absolute path to the sync repo root.
 * @param useHost - When true, target `hosts/<HOST>.json`; else target `shared/settings.base.json`.
 * @returns `{ destPath, existing }` where `existing` is the current file content (or `{}`).
 */
function resolveCaptureDestination(
  repo: string,
  useHost: boolean,
): { destPath: string; existing: Record<string, unknown> } {
  const destPath = useHost
    ? join(repo, 'hosts', `${HOST}.json`)
    : join(repo, 'shared', 'settings.base.json');
  const existing = existsSync(destPath) ? readJson<Record<string, unknown>>(destPath) : {};
  return { destPath, existing };
}

/**
 * Promote local-only settings keys into the shared repo.
 *
 * Reads `shared/settings.base.json`, `hosts/<HOST>.json` (when present), and
 * `~/.claude/settings.json`. Computes the ahead-only capture subset via the
 * Plan-01 core. When non-empty, merges the subset into the destination repo
 * file (base by default, host with `--host`), backs up the destination via
 * `backupRepoWrite`, writes atomically, then calls `regenerateSettings` so
 * the local file matches. Idempotent when no ahead-only keys remain.
 *
 * @param opts Command options (host destination flag, dry-run flag).
 */
export function cmdCaptureSettings(opts: CaptureSettingsOpts): void {
  const { host: useHost, dryRun } = opts;

  const repo = repoHome();
  if (!existsSync(repo)) die(`repo not cloned at ${repo}`);

  const handle = acquireLock('capture-settings');
  if (handle === null) process.exit(0);
  try {
    const claude = claudeHome();
    const basePath = join(repo, 'shared', 'settings.base.json');
    if (!existsSync(basePath)) {
      die("repo not initialized; run 'nomad init' to scaffold");
    }

    const settingsPath = join(claude, 'settings.json');
    if (!existsSync(settingsPath)) {
      log('no ~/.claude/settings.json found; nothing to capture');
      return;
    }

    const base = readJson<Record<string, unknown>>(basePath);
    const hostPath = join(repo, 'hosts', `${HOST}.json`);
    const overrides = existsSync(hostPath) ? readJson<Record<string, unknown>>(hostPath) : {};
    const merged = deepMerge(base, overrides);

    const settings = readJson<Record<string, unknown>>(settingsPath);
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: !useHost });

    if (Object.keys(subset).length === 0) {
      log('nothing to capture: no local-only keys found');
      return;
    }

    const { destPath, existing } = resolveCaptureDestination(repo, useHost);
    const newContent = deepMerge(existing, subset as Partial<typeof existing>);

    if (dryRun) {
      const dest = useHost ? `hosts/${HOST}.json` : 'shared/settings.base.json';
      log(`dry-run: would write ${dest} with keys: ${Object.keys(subset).sort().join(', ')}`);
      return;
    }

    const ts = freshBackupTs(backupBase());
    backupRepoWrite(destPath, ts, repo);
    writeJsonAtomic(destPath, newContent);

    // Resync the local file from the now-updated repo source. Suppress the
    // pull-side drift WARN: re-advising 'nomad capture-settings' in the run that
    // just captured would be contradictory, and any keys still classified ahead
    // here are the excluded credential keys that capture intentionally refuses.
    regenerateSettings(ts, { suppressDriftWarn: true });
    const dest = useHost ? `hosts/${HOST}.json` : 'shared/settings.base.json';
    log(`captured ${Object.keys(subset).length} key(s) into ${dest} (backup: ${ts})`);
  } catch (err) {
    /* c8 ignore next 3 */
    if (!(err instanceof NomadFatal)) {
      throw err;
    }
    die(err.message);
  } finally {
    releaseLock(handle);
  }
}
