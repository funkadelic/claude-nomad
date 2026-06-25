/**
 * Path segments that must never cross the sync boundary in either direction.
 * Defense-in-depth pair with `PUSH_ALLOWED_STATIC`: even if the allow-list
 * misses a path, anything containing one of these segments is hard-blocked.
 * Also the deny-list the `sharedDirs` opt-in is validated against, so a user
 * cannot symlink a host-local secret or cache into the shared repo by naming
 * it in `path-map.json`.
 *
 * Lives in its own dependency-free leaf module (imported by both `config.ts`,
 * which re-exports it, and `config.sharedDirs.guard.ts`) so the guard does not
 * have to import `config.ts` for it. That import was the load-bearing edge of a
 * `config.ts` <-> `config.sharedDirs.guard.ts` cycle; keeping the constant here
 * preserves the strict bottom-up, no-circular-import layering.
 */
export const NEVER_SYNC = new Set([
  '.claude.json',
  '.credentials.json',
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
  // Host-local caches and runtime state (sharedDirs guard also rejects these).
  'cache',
  'backups',
  'paste-cache',
  'daemon',
  'jobs',
  'tasks',
  'security',
  'sessions',
]);

/**
 * Denylist for the `.claude` per-project extra: the full `NEVER_SYNC` set plus
 * `projects` (session transcripts). `projects` is deliberately absent from
 * `NEVER_SYNC` because mapped projects sync their transcripts through the
 * path-remap mechanism into `shared/projects/<logical>/` (a runtime allow-list
 * entry); adding it to `NEVER_SYNC` would hard-block that destination. But a raw
 * `.claude/` extra tree must still strip a `projects/` dir so transcripts never
 * ride through the extras gate. Used by `extrasDenySet` (the copy filter) and
 * `blockSetFor` (the push gate) so both agree on the `.claude` boundary.
 */
export const CLAUDE_EXTRA_NEVER_SYNC = new Set([...NEVER_SYNC, 'projects']);

/**
 * Credential-bearing filename patterns that must never cross the sync boundary,
 * independent of the exact-name denylists above. The exact-name sets enumerate
 * known Claude Code host-state files; these patterns catch the broader family of
 * generic secret files (dotenv, private keys, npm/netrc auth) that gitleaks does
 * not reliably flag by content. Anchored to filename SHAPE (extension or exact
 * dotfile name) and case-insensitive, so `Settings.local.json`-style case-fold
 * tricks and extension variants (`.env.local`, `server.pem`) are both covered.
 * Applied to opt-in `.planning`/`.claude` extras, where gitleaks is otherwise
 * the only content backstop.
 */
const SECRET_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pgpass$/i,
  /^\.git-credentials$/i,
  /^credentials$/i,
];

/**
 * True when `name` matches a credential-bearing filename pattern (see
 * `SECRET_FILE_PATTERNS`). Basename test only; callers pass a single path
 * segment.
 *
 * @param name A single path segment (basename) to test.
 */
export function isSecretFileName(name: string): boolean {
  return SECRET_FILE_PATTERNS.some((re) => re.test(name));
}

/**
 * Denylist membership for the sync boundary, hardened on two axes over a raw
 * `blockSet.has(name)`:
 *   1. Case-insensitive: the exact-name sets are all lowercase, so a host on a
 *      case-insensitive filesystem (macOS default) could otherwise slip a
 *      `Settings.local.json` past `Set.has` yet land it on the same inode as the
 *      denied `settings.local.json`. Lowercasing the probe closes that.
 *   2. Secret-file patterns: ORs in `isSecretFileName` so credential filetypes
 *      the exact sets do not enumerate are still blocked.
 *
 * @param blockSet The exact-name denylist for the context (e.g. the result of
 *   `extrasDenySet`, or `ALWAYS_NEVER_SYNC`).
 * @param name A single path segment (basename) to test.
 */
export function isDeniedName(blockSet: Set<string>, name: string): boolean {
  return blockSet.has(name) || blockSet.has(name.toLowerCase()) || isSecretFileName(name);
}
