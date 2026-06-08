import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';

import { isValidSharedDir } from './config.sharedDirs.guard.ts';
import { warn } from './utils.ts';

/**
 * Resolved home directory. Reads `process.env.HOME` first (empty string falls
 * through) and falls back to Node's `os.homedir()` (`getpwuid_r()` on POSIX
 * when the env var is unset). Returns `""` only in pathological environments
 * (no env, no uid mapping); callers should verify it is non-empty at CLI
 * entry via `nomad.ts`.
 *
 * The explicit `process.env.HOME` read is load-bearing for worker threads:
 * `process.env` mutations in a `worker_threads` worker update only that
 * isolate's copy, while `os.homedir()` reads the real process environ and
 * stays blind to them. Tools that run tests in worker threads (Stryker's
 * vitest runner forces `pool: 'threads'`) need the env read for the
 * tests' HOME swap to take effect.
 *
 * Call-time resolver: resolved on each call, not at module load.
 */
export function home(): string {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  return process.env.HOME || homedir();
}

/**
 * Absolute path to the user's Claude Code config directory (`~/.claude`).
 * Resolved on each call so environment changes are reflected immediately.
 */
export function claudeHome(): string {
  return resolve(home(), '.claude');
}

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
 *
 * Resolved on each call so mid-process `NOMAD_REPO` changes are reflected
 * without `vi.resetModules()`.
 */
export function repoHome(): string {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  return process.env.NOMAD_REPO || resolve(home(), 'claude-nomad');
}

/**
 * Host-local backup cache root (`~/.cache/claude-nomad/backup`). Single
 * source of truth for the backup root. Resolved on each call so environment
 * changes are reflected immediately.
 */
export function backupBase(): string {
  return join(home(), '.cache', 'claude-nomad', 'backup');
}

/**
 * The official Claude Code settings JSON schema. Source of truth for
 * `SCHEMA_KEYS` (kept current by `scripts/sync-settings-keys.ts`) and the
 * on-demand `nomad doctor --check-schema` reporter, which fetches it live to
 * flag local `settings.json` keys absent from the published schema.
 */
export const SETTINGS_SCHEMA_URL = 'https://json.schemastore.org/claude-code-settings.json';

/**
 * npm registry endpoint for the latest published `claude-nomad` release. Fetched
 * live by `nomad doctor`'s soft release-version check (`fetchLatestVersion`) to
 * compare the local `package.json.version` against the latest upstream tag. The
 * `version` field in the response is already bare semver (no leading `v`).
 */
export const NPM_REGISTRY_LATEST_URL = 'https://registry.npmjs.org/claude-nomad/latest';

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
  'hooks',
] as const;

/**
 * Returns the union of `SHARED_LINKS` and any validated entries from
 * `map.sharedDirs`. Entries that fail the `isValidSharedDir` guard (path
 * separators, NEVER_SYNC names, reserved shared/ names) are dropped with a
 * single WARN per entry; the remaining valid entries are appended after the
 * static `SHARED_LINKS` names. Callers iterate the result with `for...of` to
 * apply the same symlink machinery to both built-in and user-configured dirs.
 *
 * @param map - Parsed `path-map.json` content.
 * @returns Array of link names to symlink under `~/.claude/`.
 */
export function allSharedLinks(map: PathMap): string[] {
  const extras: string[] = [];
  for (const entry of map.sharedDirs ?? []) {
    if (isValidSharedDir(entry)) {
      extras.push(entry);
    } else {
      warn(
        `sharedDirs entry ${JSON.stringify(entry)} is invalid (path separator, reserved name, or NEVER_SYNC); skipping`,
      );
    }
  }
  return [...SHARED_LINKS, ...extras];
}

/**
 * Whitelist of names allowed in the `extras` field of `path-map.json`. Each
 * entry is a directory (e.g. `.planning`) or root-level file (`CLAUDE.md`)
 * copied under `shared/extras/<logical>/<name>`. Only listed names are
 * eligible for sync; widening is a one-line edit with no migration required.
 *
 * `.claude` is supported and filtered against `CLAUDE_EXTRA_NEVER_SYNC` (the
 * full `NEVER_SYNC` set plus `projects`), not just the `ALWAYS_NEVER_SYNC`
 * secret subset: its tree mirrors `~/.claude/` semantics, so ephemeral/
 * host-local names (`settings.local.json`, `projects/`, `shell-snapshots/`,
 * `statsig/`, `sessions/`, `todos/`, ...) are stripped on push, leaving only
 * config (`settings.json`, `hooks/`, `agents/`, `skills/`, `commands/`,
 * `rules/`). `.planning` keeps the narrow `ALWAYS_NEVER_SYNC` subset so its
 * legitimate `todos`/`plans` content passes. See `extrasDenySet` in
 * `extras-sync.core.ts`.
 */
export const SUPPORTED_EXTRAS = ['.planning', 'CLAUDE.md', '.claude'] as const;

/**
 * Credential and host-config file names blocked even under `shared/extras/`,
 * where the broader `NEVER_SYNC` segment scan is narrowed to avoid
 * false-blocking ephemeral dir names (`todos`, `plans`, etc.) inside synced
 * `.planning/` trees (Pitfall 6). Strict subset of `NEVER_SYNC`; doctor
 * display and sharedDirs guard use the full set.
 */
export const ALWAYS_NEVER_SYNC = new Set([
  '.claude.json',
  '.credentials.json',
  'settings.local.json',
  'history.jsonl',
  'stats-cache.json',
]);

// Path segments that must never cross the sync boundary. Defined in
// ./config.never-sync.ts (a dependency-free leaf) so config.sharedDirs.guard.ts
// can import it without importing config.ts (which would re-form a cycle);
// re-exported here so existing `from './config.ts'` imports keep resolving.
export { NEVER_SYNC, CLAUDE_EXTRA_NEVER_SYNC } from './config.never-sync.ts';

// Schema-drift baseline for `~/.claude/settings.json`; top-level keys not in
// this set trigger a `nomad doctor` WARN. Defined in ./settings-keys.ts so the
// schema-derived half can be re-synced mechanically; re-exported here so
// existing `from './config.ts'` imports keep resolving.
export { KNOWN_SETTINGS_KEYS } from './settings-keys.ts';

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
  'shared/hooks/',
  'hosts/',
  'path-map.json',
  '.gitleaksignore', // written by nomad push Allow action (D-04)
  '.gitleaks.overlay.toml', // user-owned gitleaks allowlist overlay layered on the bundled base
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
 *
 * Optional `sharedDirs` field (additive, top-level): opt-in global support
 * directories under `~/.claude/` to include in the `SHARED_LINKS` symlink set.
 * Each entry is a single path segment (e.g. `"get-shit-done"`); entries that
 * fail the `isValidSharedDir` guard are dropped with a WARN and never reach the
 * filesystem. Absence of the field is equivalent to no extra shared dirs; legacy
 * `path-map.json` files without a `sharedDirs` block continue to work unchanged.
 */
export type PathMap = {
  projects: Record<string, Record<string, string>>;
  extras?: Record<string, string[]>;
  sharedDirs?: string[];
};
