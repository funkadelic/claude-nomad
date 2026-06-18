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
 *
 * Algorithm: split the command on whitespace, skip the first token (launcher),
 * skip any leading-dash flag tokens, take the first non-flag token as the
 * script path. Return `basename.startsWith(GSD_PREFIX)`.
 *
 * Fail-safe: if no script token is found the command is unparseable; return
 * `false` so a user entry is never silently dropped (T-55-01 accept).
 *
 * @param command - Raw `command` string from a hook entry.
 * @returns `true` if gsd-owned; `false` if user-authored or unparseable.
 */
export function isGsdHookEntry(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  // tokens[0] is the launcher (node, bash, /abs/path/to/node, ...)
  // Walk remaining tokens, skip flags (start with '-'), take first non-flag.
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
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
    if (result !== null) kept.push(result);
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
 * D-03 prune order (innermost-first):
 * 1. Drop each inner `hooks[]` command entry where `isGsdHookEntry` returns
 *    `true`.
 * 2. Drop the matcher entry when its inner `hooks` array becomes empty.
 * 3. Drop the event key when its matcher array becomes empty.
 * 4. Remove the `hooks` key itself when no event keys remain.
 *
 * Fail-safe: a `hooks` value that is not a plain object, an event value that
 * is not an array, or a matcher entry that lacks an inner `hooks` array is
 * passed through unchanged. The function never throws, never mutates its
 * input, and never corrupts a shape it does not recognize (T-55-02 mitigate).
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
