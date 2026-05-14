import { hostname } from 'node:os';
import { resolve } from 'node:path';

export const CLAUDE_HOME = resolve(process.env.HOME ?? '', '.claude');
export const REPO_HOME = resolve(process.env.HOME ?? '', 'claude-nomad');
export const HOST = hostname().toLowerCase();

export const SHARED_LINKS = ['CLAUDE.md', 'agents', 'skills', 'commands', 'rules'] as const;

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
