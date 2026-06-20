import { GSD_PREFIX } from './config.ts';

/**
 * Launcher binaries that may precede a script token. Used to tell a launcher
 * that carries a path (e.g. `/usr/bin/node script.js`) apart from a
 * launcher-less script that carries a path (e.g. `/a/hooks/gsd-x.js --flag`).
 */
const KNOWN_LAUNCHER_BASENAMES = new Set(['node', 'bash', 'sh']);

/**
 * Basename of a path token (handles both `/` and `\` separators).
 *
 * @param token - A command token that may be a path.
 * @returns The last path segment, or the token unchanged when it has no separator.
 */
function scriptBasename(token: string): string {
  const lastSlash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return lastSlash >= 0 ? token.slice(lastSlash + 1) : token;
}

/**
 * Strip a single matching pair of surrounding ASCII quotes (double or single)
 * from a command token. Hook commands frequently wrap launcher and script
 * paths in double quotes (e.g. `"/abs/path/node" "/abs/path/gsd-x.js"`); the
 * whitespace tokenizer keeps those quotes attached, so the basenames would
 * otherwise read as `node"` / `gsd-x.js"` and evade both launcher detection
 * and the `gsd-` prefix check. No-op for an unquoted token.
 *
 * @param token - A single whitespace-delimited command token.
 * @returns The token with one balanced pair of surrounding quotes removed.
 */
function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const head = token.at(0);
    const tail = token.at(-1);
    if ((head === '"' && tail === '"') || (head === "'" && tail === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

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
 * - `"/abs/path/node" "/abs/path/gsd-x.js"` (launcher and script both quoted)
 *
 * Algorithm: split the command on whitespace, strip a balanced pair of
 * surrounding quotes from each candidate token, and skip any leading `KEY=value`
 * environment-assignment tokens. If the first remaining token is itself the
 * script (it carries a path and is not a known launcher binary, or its basename
 * already starts with `gsd-`), classify off that token's basename directly. This
 * covers launcher-less commands with or without trailing args/flags, and keys
 * off the script itself so a trailing `gsd-`-prefixed argument can never mark a
 * user script as gsd-owned. Otherwise the first token is the launcher: skip flag
 * tokens and take the first non-flag token as the script path. Return
 * `basename.startsWith(GSD_PREFIX)`.
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
  // identifier: starts with a letter or underscore, then word characters.
  const envAssign = /^[A-Za-z_]\w*=/;
  let i = 0;
  while (i < tokens.length && envAssign.test(tokens[i])) {
    i++;
  }

  const first = stripQuotes(tokens[i] ?? '');
  const firstBase = scriptBasename(first);
  const firstHasPath = first.includes('/') || first.includes('\\');

  // Launcher-less form: the first non-env token is itself the script. True when it
  // carries a path and is not a known launcher binary, or its basename already
  // starts with GSD_PREFIX. Covers `/a/hooks/gsd-x.js`, the same with trailing
  // args/flags, and a bare `gsd-x.js`. Classifying off the script token means a
  // trailing gsd-prefixed ARGUMENT can never mark a user script as gsd-owned.
  if ((firstHasPath && !KNOWN_LAUNCHER_BASENAMES.has(firstBase)) || first.startsWith(GSD_PREFIX)) {
    return firstBase.startsWith(GSD_PREFIX);
  }

  // Otherwise tokens[i] is the launcher: skip flag tokens, take the first
  // non-flag token as the script path. A launcher with no script -> false.
  for (let j = i + 1; j < tokens.length; j++) {
    if (tokens[j].startsWith('-')) continue;
    return scriptBasename(stripQuotes(tokens[j])).startsWith(GSD_PREFIX);
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
