import { hostname } from 'node:os';
import { resolve } from 'node:path';

export const CLAUDE_HOME = resolve(process.env.HOME ?? '', '.claude');
export const REPO_HOME = resolve(process.env.HOME ?? '', 'claude-nomad');
// Empty string must fall through to hostname(); `??` would treat '' as set.
// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
export const HOST = (process.env.NOMAD_HOST || hostname()).toLowerCase();

export const SHARED_LINKS = [
  'CLAUDE.md',
  'agents',
  'skills',
  'commands',
  'rules',
  'my-statusline.cjs',
] as const;

export const NEVER_SYNC = new Set([
  '.claude.json',
  'history.jsonl',
  'stats-cache.json',
  'todos',
  'shell-snapshots',
  'debug',
  'file-history',
  'plans',
  'session-env',
  'statsig',
  'telemetry',
  'ide',
]);

// PUSH_ALLOWED_STATIC: D-14 static half. Entries with trailing '/' are prefix
// matches; others are exact matches. Data-driven shared/projects/<logical>/
// entries are added at runtime in enforceAllowList.
export const PUSH_ALLOWED_STATIC = [
  'shared/CLAUDE.md',
  'shared/my-statusline.cjs',
  'shared/settings.base.json',
  'shared/agents/',
  'shared/skills/',
  'shared/commands/',
  'shared/rules/',
  'shared/.gitignore',
  'hosts/',
  'path-map.json',
] as const;

export type PathMap = { projects: Record<string, Record<string, string>> };
