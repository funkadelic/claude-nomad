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
  'my-statusline.js',
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

export type PathMap = { projects: Record<string, Record<string, string>> };
