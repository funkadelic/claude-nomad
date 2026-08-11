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
 * Credential and host-config file names blocked even under `shared/extras/`,
 * where the broader `NEVER_SYNC` segment scan is narrowed to avoid
 * false-blocking ephemeral dir names (`todos`, `plans`, etc.) inside synced
 * `.planning/` trees. Strict subset of `NEVER_SYNC`; doctor display and the
 * sharedDirs guard use the full set.
 *
 * Lives beside its two siblings in this dependency-free leaf rather than in
 * `config.ts`, so `blockSetFor` below can choose between all three without the
 * leaf taking an import. `config.ts` re-exports it, so every existing
 * `from './config.ts'` import keeps resolving.
 */
export const ALWAYS_NEVER_SYNC = new Set([
  '.claude.json',
  '.credentials.json',
  'settings.local.json',
  'history.jsonl',
  'stats-cache.json',
]);

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
 * Drop every trailing `.` and every trailing whitespace character (space,
 * tab, newline, carriage return, and every other character JavaScript's
 * `\s` class matches, including U+00A0 non-breaking space) from `name`, in
 * any order and any count, giving the name underneath those characters. May
 * return the empty string when `name` is composed entirely of dots and
 * whitespace.
 *
 * A descending index loop rather than a `/[.\s]+$/` replace: an anchored
 * quantifier over a repeated character class is the shape
 * `sonarjs/super-linear-regex` rejects, and this runs on unvalidated
 * filesystem input.
 *
 * The reason to normalize before a deny-list test: an anchored pattern set
 * like `SECRET_FILE_PATTERNS` is defeated by a trailing character that costs
 * an attacker nothing to add, and `.env.` (or `.env<TAB>`) is a credential
 * file by every meaning that matters to the deny-list even though it is a
 * distinct real name to `node:fs`. The transform is the identity on any name
 * carrying no trailing dot or whitespace, so applying it before the test is
 * monotonically more restrictive: it can only ever cause a name to be denied
 * that was already denied without the trailing character, never the
 * reverse. This module takes no imports and must stay a dependency-free
 * leaf.
 *
 * @param name A single path segment (basename) to normalize.
 * @returns `name` with trailing dots and whitespace removed, possibly empty.
 */
export function stripTrailingDotsAndWhitespace(name: string): string {
  let end = name.length;
  while (end > 0 && (name[end - 1] === '.' || /\s/.test(name[end - 1]))) end -= 1;
  return name.slice(0, end);
}

/**
 * True when `name` matches a credential-bearing filename pattern (see
 * `SECRET_FILE_PATTERNS`). Basename test only; callers pass a single path
 * segment.
 *
 * Tests the candidate after {@link stripTrailingDotsAndWhitespace}, so a
 * trailing-dot or trailing-whitespace spelling like `.env.` or `server.pem `
 * is denied exactly like its plain spelling: see that function's docstring
 * for the monotonicity argument. `config.sharedDirs.guard.ts` hands this
 * predicate a name already stripped of trailing dots and whitespace via its
 * own `classifyDeniedName`, so the second normalization is the identity
 * there.
 *
 * @param name A single path segment (basename) to test.
 */
export function isSecretFileName(name: string): boolean {
  const stripped = stripTrailingDotsAndWhitespace(name);
  return SECRET_FILE_PATTERNS.some((re) => re.test(stripped));
}

/**
 * Denylist membership for the sync boundary, hardened on three axes over a raw
 * `blockSet.has(name)`:
 *   1. Case-insensitive: the exact-name sets are all lowercase, so a host on a
 *      case-insensitive filesystem (macOS default) could otherwise slip a
 *      `Settings.local.json` past `Set.has` yet land it on the same inode as the
 *      denied `settings.local.json`. Lowercasing the probe closes that.
 *   2. Secret-file patterns: ORs in `isSecretFileName` so credential filetypes
 *      the exact sets do not enumerate are still blocked.
 *   3. Trailing dots and whitespace: the exact-name probe also tests
 *      `stripTrailingDotsAndWhitespace(name)` and its lowercase form, so
 *      `settings.local.json.` bypasses this axis by the same trivially-cheap
 *      evasion `isSecretFileName` closes on the pattern axis, in the same
 *      function. See {@link stripTrailingDotsAndWhitespace} for the
 *      monotonicity argument.
 *
 * @param blockSet The exact-name denylist for the context (e.g. the result of
 *   `extrasDenySet`, or `ALWAYS_NEVER_SYNC`).
 * @param name A single path segment (basename) to test.
 */
export function isDeniedName(blockSet: Set<string>, name: string): boolean {
  const stripped = stripTrailingDotsAndWhitespace(name);
  return (
    blockSet.has(name) ||
    blockSet.has(name.toLowerCase()) ||
    blockSet.has(stripped) ||
    blockSet.has(stripped.toLowerCase()) ||
    isSecretFileName(name)
  );
}

/**
 * True when `name` is a spelling of the `.claude` extra directory: the exact
 * lowercase name after normalizing trailing dots/whitespace and case-folding.
 * `isDeniedName` hardened *membership* in a deny set on the case and
 * trailing-character axes; this closes the same two axes for the sibling
 * *selection* comparisons in `blockSetFor` below and in
 * `extras-sync.core.ts` that choose WHICH deny set (`CLAUDE_EXTRA_NEVER_SYNC`
 * vs `ALWAYS_NEVER_SYNC`) applies to a `.claude` extra's contents. Without
 * this, a spelling like `.Claude` (same directory as `.claude` on
 * case-insensitive filesystems) or `.claude.` silently downgrades to the
 * narrower denylist, which does not contain `projects`.
 *
 * @param name A single path segment (basename) to test.
 */
export function isClaudeExtraName(name: string): boolean {
  return stripTrailingDotsAndWhitespace(name).toLowerCase() === '.claude';
}

/**
 * Choose the hard-block denylist for a repo-relative path's segments. Outside
 * the extras tree the full `NEVER_SYNC` set applies. Inside `shared/extras/`
 * the narrow `ALWAYS_NEVER_SYNC` subset applies, so legitimate GSD content such
 * as `.planning/todos/` passes, EXCEPT for the `.claude` extra:
 * its subtree mirrors `~/.claude/` semantics, so its ephemeral segment names
 * (`projects`, `shell-snapshots`, `sessions`, `todos`, ...) get the full
 * `NEVER_SYNC` boundary. Mirrors `extrasDenySet` in `extras-sync.core.ts` so
 * the push gate and the copy filter agree on the boundary. The `.claude`
 * comparison runs through `isClaudeExtraName` (case-insensitive, trailing
 * dot/whitespace normalized) rather than a raw `===`, so a spelling like
 * `.Claude` or `.claude.` cannot silently downgrade to the narrower
 * `ALWAYS_NEVER_SYNC` set.
 *
 * @param segments A repo-relative path already split on `/`.
 * @returns The exact-name denylist that applies to that path.
 */
export function blockSetFor(segments: string[]): Set<string> {
  if (segments[0] !== 'shared' || segments[1] !== 'extras') return NEVER_SYNC;
  return isClaudeExtraName(segments[3] ?? '') ? CLAUDE_EXTRA_NEVER_SYNC : ALWAYS_NEVER_SYNC;
}

/**
 * The first path segment of `path` that matches the hard-block denylist for
 * that path (see `blockSetFor`), or `null` when no segment matches. Tested via
 * `isDeniedName` so the match is case-insensitive (macOS case-fold) and also
 * covers credential-file patterns (dotenv, private keys, npm/netrc auth) the
 * exact sets do not enumerate. Genuinely-sensitive host-local files stay
 * blocked even when nested inside a synced extras dir. Inside
 * `shared/extras/<logical>/<dirname>/` only the content segments (index 4+) are
 * scanned: the `<logical>` and `<dirname>` names are not denylist tokens, and a
 * logical that happens to equal a `NEVER_SYNC` token (e.g. a project named
 * `sessions`) must not hard-block its own legitimate files.
 *
 * Returns the segment rather than a bare boolean because the denylists hold
 * ordinary-looking directory names (`tasks`, `plans`, `sessions`, ...), so a
 * caller telling a user their path was refused has to be able to say WHICH name
 * did it or the user has no action to take. `isNeverSync` is the boolean view
 * of this same scan.
 *
 * @param path A repo-relative, forward-slashed path.
 * @returns The matching segment, or `null` when the path is clean.
 */
export function deniedSegmentFor(path: string): string | null {
  const segments = path.split('/');
  const blockSet = blockSetFor(segments);
  const scan = segments[0] === 'shared' && segments[1] === 'extras' ? segments.slice(4) : segments;
  for (const segment of scan) {
    if (isDeniedName(blockSet, segment)) return segment;
  }
  return null;
}

/**
 * True when any segment of `path` matches the hard-block denylist for that path.
 * The boolean view of {@link deniedSegmentFor}, which owns the scan; both the
 * push allow-list gate and the pull-side mirror gate run through this one
 * implementation so they cannot drift apart.
 *
 * @param path A repo-relative, forward-slashed path.
 */
export function isNeverSync(path: string): boolean {
  return deniedSegmentFor(path) !== null;
}
