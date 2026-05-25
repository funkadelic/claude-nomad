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

/**
 * Absolute path to the local checkout of the private sync repo. Reads
 * `NOMAD_REPO` first, falls back to `~/claude-nomad`. A set-but-empty
 * `NOMAD_REPO` (e.g. `export NOMAD_REPO=` in a dotfile that clobbers the
 * variable) must also fall through to the default. `??` only triggers on
 * null/undefined, so `||` is used here to fall through on empty strings too.
 * Relative paths in `NOMAD_REPO` are resolved against the current working
 * directory at first use (downstream `existsSync` / `cpSync` / git invocations
 * accept either absolute or relative paths); we intentionally do NOT
 * `resolve()` here so developers can point the override at relative checkouts.
 */
// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
export const REPO_HOME = process.env.NOMAD_REPO || resolve(HOME, 'claude-nomad');

/**
 * Upstream GitHub repository slug for the release-version check in
 * `nomad doctor`. Hardcoded for the same reason `REPO_HOME` is hardcoded:
 * the deployed sync target is canonical for this CLI. Source of truth for
 * the `GET /repos/<slug>/releases/latest` call in `reportVersionCheck`.
 */
export const UPSTREAM_REPO_SLUG = 'funkadelic/claude-nomad';

/**
 * Pinned gitleaks version. Single source of truth for the gitleaks pin used by
 * `nomad doctor`'s version-drift check (`reportGitleaksVersionCheck`), which
 * WARNs when the host's installed gitleaks major.minor diverges from this
 * value. Mirrors the `GITLEAKS_VERSION` env in both `.github/workflows/tests.yml`
 * and `.github/workflows/gitleaks.yml`; `config.gitleaks-pin.test.ts` asserts
 * all three stay in lockstep so a CI bump that misses this constant (or vice
 * versa) fails the suite. Bump here and in both workflow YAMLs together.
 */
export const GITLEAKS_PINNED_VERSION = '8.30.1';

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
 * Whitelist of names allowed in `path-map.json`'s top-level `extras` field.
 * Each entry is either a directory name (e.g. `.planning`) OR a single
 * root-level file name (e.g. `CLAUDE.md`); both are validated the same way
 * and copied verbatim under `shared/extras/<logical>/<name>`. Gates the
 * named-extras opt-in mechanism: only entries appearing in this list are
 * eligible for sync. Widening to include `.notes`, `.scratch`, `AGENTS.md`,
 * etc. is a one-line edit here with no schema migration required (the field
 * is additive on the consumer side). Mirrors `SHARED_LINKS` in shape and
 * intent: a short, append-only `as const` tuple that downstream callers
 * narrow against.
 */
export const SUPPORTED_EXTRAS = ['.planning', 'CLAUDE.md'] as const;

/**
 * Path segments that must never cross the sync boundary in either direction.
 * Defense-in-depth pair with `PUSH_ALLOWED_STATIC`: even if the allow-list
 * misses a path, anything containing one of these segments is hard-blocked.
 */
export const NEVER_SYNC = new Set([
  '.claude.json',
  'history.jsonl',
  'settings.local.json',
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
 *
 * Optional `extras` field (additive, top-level): opt-in per-project sync of
 * named content. Keyed by the same logical project name used in `projects`;
 * values are arrays of directory or root-file names validated by downstream
 * consumers against `SUPPORTED_EXTRAS`. Absence of the field is equivalent
 * to no extras for any project; legacy `path-map.json` files without an
 * `extras` block continue to work unchanged (no migration required).
 */
export type PathMap = {
  projects: Record<string, Record<string, string>>;
  extras?: Record<string, string[]>;
};
