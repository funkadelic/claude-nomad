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

// ---------------------------------------------------------------------------
// Keep walker helpers (the complement of the strip walker; keep gsd-only)
// ---------------------------------------------------------------------------

/**
 * Keep only the gsd-owned inner hook entries of a single matcher entry (the
 * complement of `filterMatcherEntry`, which DROPS them). Returns `null` when no
 * gsd inner hook remains (signal to the caller to drop the matcher entry).
 *
 * Fail-safe: an entry that is not a plain object, or one lacking an inner
 * `hooks` array, contributes nothing to the kept subtree and returns `null`
 * (unlike strip, which passes such shapes through). Inner hook entries that are
 * not plain objects, or whose `command` is not a string, are treated as
 * non-gsd and dropped.
 *
 * @param entry - A matcher object expected to have an `hooks` array.
 * @returns The entry narrowed to its gsd inner hooks, or `null` when none.
 */
function keepMatcherEntry(entry: unknown): Record<string, unknown> | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const entryObj = entry as Record<string, unknown>;
  if (!Array.isArray(entryObj.hooks)) return null;

  const innerHooks = entryObj.hooks as unknown[];
  const kept = innerHooks.filter((h) => {
    if (h === null || typeof h !== 'object' || Array.isArray(h)) return false;
    const hookObj = h as Record<string, unknown>;
    const cmd = hookObj.command;
    return isGsdHookEntry(typeof cmd === 'string' ? cmd : '');
  });
  if (kept.length === 0) return null;
  return { ...entryObj, hooks: kept };
}

/**
 * Keep one event's gsd-owned matcher entries (e.g. the `SessionStart` array),
 * the complement of `filterEventMatchers`. Returns `null` when no matcher entry
 * retains a gsd inner hook (signal to drop the event key), or when `matchers`
 * is not an array (fail-safe: unrecognized shapes contribute nothing).
 *
 * @param matchers - The array value of one event key in the hooks block.
 * @returns Array of kept matcher entries, or `null` when none.
 */
function keepEventMatchers(matchers: unknown): unknown[] | null {
  if (!Array.isArray(matchers)) return null;
  const kept: Record<string, unknown>[] = [];
  for (const entry of matchers) {
    const result = keepMatcherEntry(entry);
    if (result !== null) kept.push(result);
  }
  return kept.length === 0 ? null : kept;
}

/**
 * Return a new object containing ONLY the gsd-owned hook subtree of `settings`
 * (`{ hooks: { <event>: [<gsd matchers>] } }`), or `{}` when the input carries
 * no gsd hooks. This is the KEEP complement of `stripGsdHookEntries`'s DROP:
 * the two partition the hook entries of any input using the shared
 * `isGsdHookEntry` predicate, so they can never disagree on what is gsd-owned.
 *
 * Prune order (innermost-first, mirroring the strip walker):
 * 1. Keep each inner `hooks[]` command entry where `isGsdHookEntry` is `true`.
 * 2. Drop the matcher entry when its kept inner hooks are empty.
 * 3. Drop the event key when its kept matchers are empty.
 * 4. Return `{}` (no `hooks` key) when no event keys remain.
 *
 * Non-`hooks` keys are never included (unlike strip, which passes them
 * through): keep returns only the gsd hook subtree.
 *
 * Fail-safe: a `hooks` value that is not a plain object, an event value that is
 * not an array, a null/array matcher entry, a matcher lacking an inner `hooks`
 * array, or an inner hook whose `command` is not a string contributes nothing
 * to the kept subtree. The function never throws and never mutates its input.
 *
 * @param settings - Parsed settings object (e.g. the live `settings.json`).
 * @returns A new object with only the gsd-owned hook subtree, or `{}`.
 */
export function keepGsdHookEntries(settings: Record<string, unknown>): Record<string, unknown> {
  const hooksVal = settings.hooks;
  if (hooksVal === null || typeof hooksVal !== 'object' || Array.isArray(hooksVal)) return {};
  const hooksObj = hooksVal as Record<string, unknown>;
  const keptHooks: Record<string, unknown> = {};
  for (const [event, matchers] of Object.entries(hooksObj)) {
    const kept = keepEventMatchers(matchers);
    if (kept !== null) keptHooks[event] = kept;
  }
  return Object.keys(keptHooks).length === 0 ? {} : { hooks: keptHooks };
}

// ---------------------------------------------------------------------------
// Hooks-union graft (preserve gsd hooks across regeneration)
// ---------------------------------------------------------------------------

/**
 * Narrow a value to a plain hooks-block object (non-null, non-array object), or
 * return `null` for any other shape. Lets `graftGsdHookEntries` fail-safe both
 * the base and gsd-only `hooks` blocks without throwing.
 *
 * @param value - Any candidate `hooks` value.
 * @returns The value as a record, or `null` when it is not a plain object.
 */
function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Build a key-order-independent structural key for a matcher entry so the dedup
 * guard treats two matchers with the same content but different key ordering as
 * equal (base comes from repo JSON, gsd from the independently-authored live
 * `settings.json`, so their key order can differ). A non-object entry falls back
 * to a raw `JSON.stringify`.
 *
 * @param m - A matcher entry (or any value from a matcher array).
 * @returns A stable string key for equality comparison.
 */
function canonicalMatcherKey(m: unknown): string {
  const obj = asPlainObject(m);
  if (obj === null) return JSON.stringify(m);
  return JSON.stringify(
    Object.keys(obj)
      .sort((a, b) => a.localeCompare(b))
      .map((k) => [k, obj[k]]),
  );
}

/**
 * Concatenate one event's `base` matcher array with `gsd` matcher entries,
 * skipping any gsd entry structurally already present in `base` OR already
 * emitted from `gsdMatchers` itself, compared via `canonicalMatcherKey` (so key
 * ordering does not defeat the guard), so a gsd matcher that survived stripping
 * is not duplicated.
 *
 * @param baseMatchers - The event's matcher array from the base side.
 * @param gsdMatchers - The event's matcher array from the gsd-only side.
 * @returns A new array: base matchers then the non-duplicate gsd matchers.
 */
function unionMatcherArrays(baseMatchers: unknown[], gsdMatchers: unknown[]): unknown[] {
  const seen = new Set(baseMatchers.map(canonicalMatcherKey));
  const merged = [...baseMatchers];
  for (const m of gsdMatchers) {
    const key = canonicalMatcherKey(m);
    if (!seen.has(key)) {
      merged.push(m);
      seen.add(key);
    }
  }
  return merged;
}

/**
 * Union `gsdOnly.hooks` into `base.hooks` per event key and return a new object.
 * For each event key present in `gsdOnly`, the matcher array is the
 * CONCATENATION of `base`'s matchers then `gsdOnly`'s matchers (a union, NOT the
 * array-replace `deepMerge` performs, which is precisely why `deepMerge` cannot
 * be reused here): a user matcher and a preserved gsd matcher coexist under one
 * event key. A gsd matcher structurally already present in `base` is not
 * appended again (dedup guard). Event keys only in `gsdOnly` are added; `base`'s
 * own event keys and all non-`hooks` keys pass through untouched (by reference).
 *
 * When `gsdOnly` carries no `hooks` (e.g. the `{}` from `keepGsdHookEntries`) or
 * an empty hooks block, `base` is returned unchanged so the serialization is
 * byte-identical (no empty `hooks: {}` scaffold is introduced).
 *
 * Fail-safe: a non-object/array `hooks` value or a non-array event value on
 * either side is treated as "nothing to union" for that key rather than
 * throwing; neither input is mutated.
 *
 * @param base - The stripped, regenerated settings (`stripGsdHookEntries` output).
 * @param gsdOnly - The preserved gsd hook subtree (`keepGsdHookEntries` output).
 * @returns A new settings object with the gsd hooks grafted back in.
 */
export function graftGsdHookEntries(
  base: Record<string, unknown>,
  gsdOnly: Record<string, unknown>,
): Record<string, unknown> {
  const gsdHooks = asPlainObject(gsdOnly.hooks);
  if (gsdHooks === null || Object.keys(gsdHooks).length === 0) return base;

  const baseHooks = asPlainObject(base.hooks);
  const mergedHooks: Record<string, unknown> = baseHooks ? { ...baseHooks } : {};
  for (const [event, gsdMatchers] of Object.entries(gsdHooks)) {
    if (!Array.isArray(gsdMatchers)) continue;
    const baseMatchers = mergedHooks[event];
    mergedHooks[event] = Array.isArray(baseMatchers)
      ? unionMatcherArrays(baseMatchers, gsdMatchers)
      : gsdMatchers;
  }
  return { ...base, hooks: mergedHooks };
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
