import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_HOME, HOST, REPO_HOME, SHARED_LINKS } from './config.ts';
import { die, ensureSymlink, deepMerge, log, readJson, writeJson } from './utils.ts';

export function applySharedLinks(): void {
  for (const name of SHARED_LINKS) {
    const target = join(REPO_HOME, 'shared', name);
    if (!existsSync(target)) continue;
    ensureSymlink(join(CLAUDE_HOME, name), target);
  }
}

export function regenerateSettings(): void {
  const basePath = join(REPO_HOME, 'shared', 'settings.base.json');
  const hostPath = join(REPO_HOME, 'hosts', `${HOST}.json`);
  if (!existsSync(basePath)) die(`missing ${basePath}`);

  const base = readJson<Record<string, unknown>>(basePath);
  const hasOverrides = existsSync(hostPath);
  const overrides = hasOverrides ? readJson<Record<string, unknown>>(hostPath) : {};
  const merged = deepMerge(base, overrides);

  writeJson(join(CLAUDE_HOME, 'settings.json'), merged);
  log(`wrote settings.json (base + ${hasOverrides ? `${HOST}.json` : 'no host overrides'})`);
}
