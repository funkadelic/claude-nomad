import { homedir, hostname } from 'node:os';
import { resolve } from 'node:path';

/**
 * Resolved home directory. Uses Node's `os.homedir()` which reads `$HOME` on
 * POSIX and falls back to `getpwuid_r()` when the env var is unset. Returns
 * `""` only in pathological environments (no env, no uid mapping); callers
 * should verify it is non-empty at CLI entry via `nomad.ts`. Centralizing the
 * lookup here prevents the `process.env.HOME ?? ''` footgun where an unset
 * `HOME` silently produced relative lockfile/backup paths.
 */
export const HOME = homedir();

/** Absolute path to the user's Claude Code config directory (`~/.claude`). */
export const CLAUDE_HOME = resolve(HOME, '.claude');

/** Absolute path to the local checkout of the private sync repo (`~/claude-nomad`). */
export const REPO_HOME = resolve(HOME, 'claude-nomad');

/**
 * Resolved host identity used to pick `hosts/<HOST>.json` and key entries in
 * `path-map.json`. Reads `NOMAD_HOST` first, falls back to `hostname()`, then
 * lowercases. A set-but-empty `NOMAD_HOST` (e.g. `export NOMAD_HOST=` in a
 * dotfile that clobbers the variable) must also fall through to `hostname()`.
 * `??` only triggers on null/undefined, so `||` is used here to fall through
 * on empty strings too.
 */
// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
export const HOST = (process.env.NOMAD_HOST || hostname()).toLowerCase();

/** Names under `shared/` that are symlinked into `~/.claude/` on every pull. */
export const SHARED_LINKS = [
  'CLAUDE.md',
  'agents',
  'skills',
  'commands',
  'rules',
  'my-statusline.cjs',
] as const;

/**
 * Path segments that must never cross the sync boundary in either direction.
 * Defense-in-depth pair with `PUSH_ALLOWED_STATIC`: even if the allow-list
 * misses a path, anything containing one of these segments is hard-blocked.
 */
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

/**
 * Schema-drift baseline for `~/.claude/settings.json`. Top-level keys not in
 * this set trigger a `nomad doctor` WARN line so we notice when Anthropic
 * adds new settings before they silently round-trip through pull. Update on
 * Anthropic settings.json schema changes.
 */
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

/**
 * Static half of the push allow-list. Entries with trailing `/` are prefix
 * matches; others are exact matches. The `hosts/` entry has special-case
 * handling in `isAllowed` to limit it to `hosts/<name>.json` (single-level
 * `.json` files only, no credentials). Data-driven
 * `shared/projects/<logical>/` entries are added at runtime in
 * `enforceAllowList`.
 */
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

/**
 * Shape of `path-map.json`. Each logical project name maps a hostname (matched
 * against `HOST`) to the absolute path the project lives at on that host. Use
 * the literal string `'TBD'` as a placeholder while a host has not yet cloned
 * the project; `remapPull` / `remapPush` skip `'TBD'` entries.
 */
export type PathMap = { projects: Record<string, Record<string, string>> };
