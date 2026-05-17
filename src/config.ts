import { hostname } from 'node:os';
import { resolve } from 'node:path';

export const CLAUDE_HOME = resolve(process.env.HOME ?? '', '.claude');
export const REPO_HOME = resolve(process.env.HOME ?? '', 'claude-nomad');
// IN-05: a set-but-empty NOMAD_HOST (e.g. `export NOMAD_HOST=` then nothing,
// or a dotfile that defines it before clobbering) must fall through to
// hostname(). `??` only triggers on null/undefined, so an empty string would
// otherwise stick and HOST would resolve to ''. `||` correctly falls through
// for both unset and empty. toLowerCase() applies AFTER the fallback so
// hostname() noise like 'WINDOWS-I5NT6OH' or 'foo.local' is also normalized.
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

// KNOWN_SETTINGS_KEYS: FMT-02 schema-drift baseline. Keys NOT in this set trigger a doctor WARN. Update on Anthropic settings.json schema changes.
export const KNOWN_SETTINGS_KEYS = new Set<string>([
  '$schema',
  'agent',
  'agents',
  'agentPushNotifEnabled',
  'allowedHttpHookUrls',
  'apiKeyHelper',
  'apiKeyHelperTimeoutMs',
  'awsAuthRefresh',
  'awsCredentialExport',
  'awsLoginRefresh',
  'awsRegion',
  'awsRetryMode',
  'cleanupPeriodDays',
  'disableNonEssentialModelCalls',
  'enabledExperimentalFeatures',
  'enabledPlugins',
  'env',
  'forceLoginMethod',
  'forceLoginOrgUUID',
  'hooks',
  'includeCoAuthoredBy',
  'installMethod',
  'model',
  'outputStyle',
  'permissions',
  'pluginGroups',
  'pluginRepositoryEnabled',
  'pluginsLocalConfig',
  'proxy',
  'statsig',
  'statusLine',
  'subagents',
  'theme',
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
