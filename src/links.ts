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

export function applySharedLinks(ts: string): void {
  // D-02 single-pass pre-scan: detect ALL non-symlink conflicts up front, backup +
  // remove each, then proceed with symlink writes (fixes Phase 1 Mac two-iteration ritual).
  // WR-02: skip pre-existing local content when the repo has no counterpart;
  // otherwise pull would silently delete host-local files (e.g.
  // ~/.claude/commands/ on a host where shared/commands/ does not exist).
  for (const name of SHARED_LINKS) {
    const linkPath = join(CLAUDE_HOME, name);
    const target = join(REPO_HOME, 'shared', name);
    if (!existsSync(linkPath)) continue;
    if (lstatSync(linkPath).isSymbolicLink()) continue;
    if (!existsSync(target)) continue;
    backupBeforeWrite(linkPath, ts);
    rmSync(linkPath, { recursive: true, force: true });
  }
  for (const name of SHARED_LINKS) {
    const target = join(REPO_HOME, 'shared', name);
    if (!existsSync(target)) continue;
    ensureSymlink(join(CLAUDE_HOME, name), target);
  }
}

export function regenerateSettings(ts: string): void {
  const basePath = join(REPO_HOME, 'shared', 'settings.base.json');
  const hostPath = join(REPO_HOME, 'hosts', `${HOST}.json`);
  if (!existsSync(basePath)) die(`missing ${basePath}`);

  const base = readJson<Record<string, unknown>>(basePath);
  const hasOverrides = existsSync(hostPath);
  const overrides = hasOverrides ? readJson<Record<string, unknown>>(hostPath) : {};
  const merged = deepMerge(base, overrides);

  const settingsPath = join(CLAUDE_HOME, 'settings.json');

  // Folded todo (pull-side surface): warn-then-proceed when no host file matches
  // AND existing settings has top-level keys not in base. Informational only;
  // pull does NOT abort. Doctor-side FAIL lands in plan 07.
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

  backupBeforeWrite(settingsPath, ts);
  writeJsonAtomic(settingsPath, merged);
  log(`wrote settings.json (base + ${hasOverrides ? `${HOST}.json` : 'no host overrides'})`);
}
