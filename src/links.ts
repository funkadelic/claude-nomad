import { existsSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_HOME, HOST, REPO_HOME, SHARED_LINKS } from './config.ts';
import {
  backupBeforeWrite,
  deepMerge,
  die,
  ensureSymlink,
  log,
  readJson,
  writeJsonAtomic,
} from './utils.ts';

/**
 * Symlink the `SHARED_LINKS` names from the repo's `shared/` dir into
 * `~/.claude/`. Two-pass: first back up and remove any pre-existing
 * non-symlink at each link path (auto-move using `ts` as the backup
 * timestamp), then create the symlinks. Skips a link entirely when the repo
 * has no counterpart, so a host where `shared/commands/` does not exist
 * keeps its local `~/.claude/commands/` instead of having it silently
 * deleted.
 *
 * `opts.dryRun` (default `false`): when `true`, no disk mutation occurs. The
 * function logs `would auto-move non-symlink:` and `would create symlink:`
 * lines describing the would-be effect and returns. Backwards-compatible: a
 * call with no opts arg or with `dryRun: false` keeps the prior mutating
 * behavior.
 */
export function applySharedLinks(ts: string, opts: { dryRun?: boolean } = {}): void {
  const dryRun = opts.dryRun === true;
  for (const name of SHARED_LINKS) {
    const linkPath = join(CLAUDE_HOME, name);
    const target = join(REPO_HOME, 'shared', name);
    if (!existsSync(linkPath)) continue;
    if (lstatSync(linkPath).isSymbolicLink()) continue;
    if (!existsSync(target)) continue;
    if (dryRun) {
      log(`would auto-move non-symlink: ${linkPath} -> backup/${ts}/${name}`);
      continue;
    }
    backupBeforeWrite(linkPath, ts);
    rmSync(linkPath, { recursive: true, force: true });
  }
  for (const name of SHARED_LINKS) {
    const target = join(REPO_HOME, 'shared', name);
    if (!existsSync(target)) continue;
    if (dryRun) {
      log(`would create symlink: ${join(CLAUDE_HOME, name)} -> ${target}`);
      continue;
    }
    ensureSymlink(join(CLAUDE_HOME, name), target);
  }
}

/**
 * Deep-merge `shared/settings.base.json` with `hosts/<HOST>.json` (when
 * present) and atomically rewrite `~/.claude/settings.json`. Composes
 * `writeJsonAtomic` (temp + fsync + rename + parent fsync) on top of
 * `backupBeforeWrite`, so an interrupted pull leaves either the pre-pull
 * file or the fully-merged file, never a half-written one. Surfaces a
 * stderr WARN when no host override exists AND prior settings has top-level
 * keys not in base; the matching doctor-side FAIL with non-zero exit lives
 * in `cmdDoctor`.
 *
 * `opts.dryRun` (default `false`): when `true`, skip the
 * `backupBeforeWrite` + `writeJsonAtomic` pair and instead log a single
 * `would write settings.json ...` line. The drift-detection WARN above
 * still fires (informational), so users see the same warning a real pull
 * would produce. The unified textual diff of the would-be-written content
 * is produced by `computePreview` in `src/preview.ts`, not here, to keep
 * this function's contract simple (mutation or log-only).
 */
export function regenerateSettings(ts: string, opts: { dryRun?: boolean } = {}): void {
  const dryRun = opts.dryRun === true;
  const basePath = join(REPO_HOME, 'shared', 'settings.base.json');
  const hostPath = join(REPO_HOME, 'hosts', `${HOST}.json`);
  if (!existsSync(basePath)) {
    die("repo not initialized; run 'nomad init' to scaffold");
  }

  const base = readJson<Record<string, unknown>>(basePath);
  const hasOverrides = existsSync(hostPath);
  const overrides = hasOverrides ? readJson<Record<string, unknown>>(hostPath) : {};
  const merged = deepMerge(base, overrides);

  const settingsPath = join(CLAUDE_HOME, 'settings.json');

  // Pull-side surface: warn-then-proceed when no host file matches AND
  // existing settings has top-level keys not in base. Informational only;
  // pull does NOT abort. The matching doctor-side FAIL with non-zero exit
  // lives in `cmdDoctor`. The WARN runs in dry-run mode too: the user sees
  // the same drift signal they would see on a real pull.
  if (!hasOverrides && existsSync(settingsPath)) {
    // Best-effort drift report. Malformed prior settings.json must not block
    // regeneration: the whole point here is to overwrite it from base+overrides.
    try {
      const existing = readJson<Record<string, unknown>>(settingsPath);
      const baseKeys = new Set(Object.keys(base));
      const drift = Object.keys(existing).filter((k) => !baseKeys.has(k));
      if (drift.length > 0) {
        process.stderr.write(
          `[nomad] WARN: no hosts/${HOST}.json found; existing settings has unbased keys ${JSON.stringify(drift)}. ` +
            `Set NOMAD_HOST to match a hosts/*.json or rerun 'nomad doctor' for candidates.\n`,
        );
      }
    } catch {
      process.stderr.write(
        `[nomad] WARN: existing settings.json is malformed; skipping drift-check and regenerating.\n`,
      );
    }
  }

  const overrideLabel = hasOverrides ? `${HOST}.json` : 'no host overrides';

  if (dryRun) {
    log(`would write settings.json (base + ${overrideLabel})`);
    return;
  }

  backupBeforeWrite(settingsPath, ts);
  writeJsonAtomic(settingsPath, merged);
  log(`wrote settings.json (base + ${overrideLabel})`);
}
