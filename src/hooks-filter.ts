import { GSD_PREFIX } from './config.ts';

/**
 * Returns `true` when a hook entry's `command` string references a script
 * whose basename starts with `gsd-`, indicating the entry was installed by
 * gsd (`@opengsd/gsd-core`) rather than authored by the user.
 *
 * Detection keys off the SCRIPT basename, not the launcher token. Launcher
 * forms seen in the wild:
 * - `node /a/b/.claude/hooks/gsd-context-monitor.js` (bare node)
 * - `node --preserve-symlinks-main /a/hooks/gsd-workflow-guard.js` (node + flag)
 * - `/home/u/.nvm/versions/node/v24/bin/node /a/hooks/gsd-config-reload.js` (absolute nvm path)
 * - `bash /a/hooks/gsd-graphify-update.sh` (bash launcher)
 * - `CLAUDE_PROJECT_DIR=/x node /a/hooks/gsd-x.js` (env-prefixed)
 * - `/a/hooks/gsd-x.js` (launcher-less, shebang executable)
 *
 * Algorithm: split the command on whitespace, skip any leading `KEY=value`
 * environment-assignment tokens (no path separator, contains `=`), then skip
 * the launcher token, skip flag tokens, and take the first non-flag token as
 * the script path. For a single-token command that contains a path separator,
 * evaluate that token's basename directly (launcher-less shebang form).
 * Return `basename.startsWith(GSD_PREFIX)`.
 *
 * Fail-safe: if no script token is found the command is unparseable; return
 * `false` so a user entry is never silently dropped.
 *
 * @param command - Raw `command` string from a hook entry.
 * @returns `true` if gsd-owned; `false` if user-authored or unparseable.
 */
export function isGsdHookEntry(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === '') return false;

  // Skip leading KEY=value env-assignment tokens. A token is an env assignment
  // when its key part (everything before the first '=') matches a shell
  // identifier: starts with a letter or underscore, contains only letters,
  // digits, and underscores, and has no path separator in the key portion.
  const envAssign = /^[A-Za-z_][A-Za-z0-9_]*=/;
  let i = 0;
  while (i < tokens.length && envAssign.test(tokens[i])) {
    i++;
  }

  // Single-token form (no launcher): evaluate the token's basename directly when
  // it contains a path separator or already starts with GSD_PREFIX.
  if (i >= tokens.length - 1) {
    const single = tokens[i] ?? '';
    const hasPath = single.includes('/') || single.includes('\\');
    if (hasPath || single.startsWith(GSD_PREFIX)) {
      const lastSlash = Math.max(single.lastIndexOf('/'), single.lastIndexOf('\\'));
      const basename = lastSlash >= 0 ? single.slice(lastSlash + 1) : single;
      return basename.startsWith(GSD_PREFIX);
    }
    // Bare launcher token (e.g. `node`) with no script: unparseable -> false.
    return false;
  }

  // Multi-token form: tokens[i] is the launcher; walk remaining tokens, skip
  // flags (start with '-'), take first non-flag as the script path.
  for (let j = i + 1; j < tokens.length; j++) {
    const token = tokens[j];
    if (token.startsWith('-')) continue;
    // Extract the basename of the script path (works for / and \ separators).
    const lastSlash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
    const basename = lastSlash >= 0 ? token.slice(lastSlash + 1) : token;
    return basename.startsWith(GSD_PREFIX);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal walker helpers (keep cognitive complexity <= 15)
// ---------------------------------------------------------------------------

/**
 * Filter a single matcher entry's inner `hooks` array, dropping gsd-owned
 * command entries. Returns `null` when the filtered array is empty (signal to
 * the caller to remove the matcher entry entirely).
 *
 * @param entry - A matcher object expected to have an `hooks` array.
 * @returns The filtered entry, or `null` when inner hooks become empty.
 */
function filterMatcherEntry(entry: unknown): Record<string, unknown> | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry as never;
  const entryObj = entry as Record<string, unknown>;
  if (!Array.isArray(entryObj.hooks)) return entryObj;

  const innerHooks = entryObj.hooks as unknown[];
  const kept = innerHooks.filter((h) => {
    if (h === null || typeof h !== 'object' || Array.isArray(h)) return true;
    const hookObj = h as Record<string, unknown>;
    const cmd = hookObj.command;
    return !isGsdHookEntry(typeof cmd === 'string' ? cmd : '');
  });
  if (kept.length === 0) return null;
  return { ...entryObj, hooks: kept };
}

/**
 * Filter one event's matcher array (e.g. the `PreToolUse` array). Returns
 * `null` when all matcher entries are removed (signal to drop the event key).
 *
 * @param matchers - The array value of one event key in the hooks block.
 * @returns Filtered array, or `null` when it becomes empty.
 */
function filterEventMatchers(matchers: unknown): unknown[] | null {
  if (!Array.isArray(matchers)) return matchers as never;
  const kept: Record<string, unknown>[] = [];
  for (const entry of matchers) {
    const result = filterMatcherEntry(entry);
    // Use loose != null to drop both null and undefined (sparse-array holes
    // yield undefined from for...of; strict !== null would push them as null).
    if (result != null) kept.push(result);
  }
  return kept.length === 0 ? null : kept;
}

// ---------------------------------------------------------------------------
// Public walker
// ---------------------------------------------------------------------------

/**
 * Return a COPY of `settings` with every gsd-owned hook entry removed from
 * the `hooks` block. Non-`hooks` keys pass through untouched by reference.
 *
 * Prune order (innermost-first):
 * 1. Drop each inner `hooks[]` command entry where `isGsdHookEntry` returns
 *    `true`.
 * 2. Drop the matcher entry when its inner `hooks` array becomes empty.
 * 3. Drop the event key when its matcher array becomes empty.
 * 4. Remove the `hooks` key itself when no event keys remain.
 *
 * Fail-safe: a `hooks` value that is not a plain object, an event value that
 * is not an array, or a matcher entry that lacks an inner `hooks` array is
 * passed through unchanged. The function never throws, never mutates its
 * input, and never corrupts a shape it does not recognize.
 *
 * @param settings - Parsed settings object (e.g. `deepMerge(base, host)`).
 * @returns A new object with gsd-owned hook entries removed.
 */
export function stripGsdHookEntries(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key !== 'hooks') {
      out[key] = value;
      continue;
    }
    // hooks must be a plain non-null object (not an array) to walk.
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      out[key] = value;
      continue;
    }
    const hooksObj = value as Record<string, unknown>;
    const filteredHooks: Record<string, unknown> = {};
    for (const [event, matchers] of Object.entries(hooksObj)) {
      const filtered = filterEventMatchers(matchers);
      if (filtered !== null) filteredHooks[event] = filtered;
    }
    if (Object.keys(filteredHooks).length > 0) out[key] = filteredHooks;
  }
  return out;
}

/**
 * Walk one matcher entry's inner `hooks` array and return `true` when at least
 * one inner hook entry is gsd-owned. Returns `false` when entry is not a plain
 * object, lacks an inner `hooks` array, or the array is empty or user-only.
 *
 * @param entry - One element of an event's matcher array.
 * @returns `true` if the entry contains a gsd-owned inner hook command.
 */
function matcherHasGsdEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const entryObj = entry as Record<string, unknown>;
  if (!Array.isArray(entryObj.hooks)) return false;
  for (const h of entryObj.hooks as unknown[]) {
    if (h === null || typeof h !== 'object' || Array.isArray(h)) continue;
    const hookObj = h as Record<string, unknown>;
    const cmd = hookObj.command;
    if (isGsdHookEntry(typeof cmd === 'string' ? cmd : '')) return true;
  }
  return false;
}

/**
 * Returns `true` only when the `hooks` block in `settings` contains at least
 * one gsd-owned inner hook entry (as detected by `isGsdHookEntry`). Returns
 * `false` for a missing `hooks` key, an empty `hooks: {}` scaffold, or a
 * `hooks` block that contains only user-authored entries.
 *
 * Use this in place of the `JSON.stringify(stripped) === JSON.stringify(base)`
 * dirty-check so call sites agree on the single predicate definition and an
 * empty `hooks: {}` scaffold is not treated as "dirty."
 *
 * @param settings - Parsed settings object (e.g. the committed base JSON).
 * @returns `true` if at least one gsd-owned hook entry is present.
 */
export function baseHasGsdHookEntries(settings: Record<string, unknown>): boolean {
  const hooksVal = settings.hooks;
  if (hooksVal === null || typeof hooksVal !== 'object' || Array.isArray(hooksVal)) return false;
  const hooksObj = hooksVal as Record<string, unknown>;
  for (const matchers of Object.values(hooksObj)) {
    if (!Array.isArray(matchers)) continue;
    for (const entry of matchers) {
      if (matcherHasGsdEntry(entry)) return true;
    }
  }
  return false;
}
