import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_HOME, HOST, REPO_HOME, SHARED_LINKS } from './config.ts';
import {
  backupBeforeWrite,
  deepMerge,
  die,
  ensureSymlink,
  log,
  nowTimestamp,
  readJson,
  writeJsonAtomic,
} from './utils.ts';

export function applySharedLinks(): void {
  for (const name of SHARED_LINKS) {
    const target = join(REPO_HOME, 'shared', name);
    if (!existsSync(target)) continue;
    ensureSymlink(join(CLAUDE_HOME, name), target);
  }
}

export function regenerateSettings(ts?: string): void {
  const effectiveTs = ts ?? nowTimestamp();
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
    const existing = readJson<Record<string, unknown>>(settingsPath);
    const baseKeys = new Set(Object.keys(base));
    const drift = Object.keys(existing).filter((k) => !baseKeys.has(k));
    if (drift.length > 0) {
      process.stderr.write(
        `[nomad] WARN: no hosts/${HOST}.json found; existing settings has unbased keys ${JSON.stringify(drift)}. ` +
          `Set NOMAD_HOST to match a hosts/*.json or rerun 'nomad doctor' for candidates.\n`,
      );
    }
  }

  backupBeforeWrite(settingsPath, effectiveTs);
  writeJsonAtomic(settingsPath, merged);
  log(`wrote settings.json (base + ${hasOverrides ? `${HOST}.json` : 'no host overrides'})`);
}
