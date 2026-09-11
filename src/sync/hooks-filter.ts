import { GSD_PREFIX } from '../core/config.ts';
import { isProtoPollutionKey } from '../core/utils.json.ts';
import { opensSubstitution, skipSubstitution } from './hooks-filter.command-sub.ts';

/**
 * Launcher binaries that may precede a script token. Used to tell a launcher
 * that carries a path (e.g. `/usr/bin/node script.js`) apart from a
 * launcher-less script that carries a path (e.g. `/a/hooks/gsd-x.js --flag`).
 *
 * `env` is here so `/usr/bin/env node script.js`, the standard portable way to
 * invoke an interpreter, is not read as a script named `env`. It only works
 * alongside the chain walk in `resolveScriptWord`, since `env` is always
 * followed by another launcher.
 */
const KNOWN_LAUNCHER_BASENAMES = new Set(['env', 'node', 'bash', 'sh']);

/**
 * Matches a leading `KEY=value` environment-assignment token: a shell
 * identifier (letter or underscore, then word characters) followed by `=`.
 * Such a token is never a script path, in launcher position or after an `env`.
 */
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;

/**
 * Shell control operators that separate commands. They are never a script path,
 * so the token walk steps over them rather than reading one as the script (which
 * would classify the entry as user-authored and lose a real gsd hook on pull).
 */
const SHELL_OPERATORS = new Set(['&&', '||', ';', '|', '&']);

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

/** A word from the command that could be the script path. */
interface Candidate {
  /** Index of the token it came from, or `-1` when no candidate remains. */
  index: number;
  /** The word itself, which may be a suffix of that token. */
  word: string;
}

/** No script word remains in the command. */
const NO_CANDIDATE: Candidate = { index: -1, word: '' };

/**
 * Walk forward to the next word that could be a script path, stepping over the
 * three kinds that never are: flag tokens, shell operators, and whole command
 * substitutions. A substitution that closes part-way through its last token
 * yields the remainder as the candidate, which is the `$(dirname "$0")/hook.js`
 * idiom for naming a file next to the script.
 *
 * `inScriptSlot` separates the two positions the classifier walks from. In
 * launcher position a substitution that is consumed whole is the LAUNCHER, so
 * the walk continues to the word after it. In the script slot that same
 * substitution IS the script, and what it expands to is unknowable, so the walk
 * gives up rather than reading the following argument as the script. The one
 * exception is a shell operator immediately after it: that ends the command and
 * starts a new one, which puts the walk back in launcher position.
 *
 * @param tokens - The whitespace-split command tokens.
 * @param from - Index to start scanning at.
 * @param inScriptSlot - `true` when the caller is looking for the script rather than the launcher.
 * @returns The next candidate word, or `NO_CANDIDATE` when none remains.
 */
function nextScriptWord(tokens: string[], from: number, inScriptSlot: boolean): Candidate {
  let slot = inScriptSlot;
  let i = from;
  while (i < tokens.length) {
    const token = tokens[i];
    if (SHELL_OPERATORS.has(token)) {
      slot = false;
      i++;
    } else if (token.startsWith('-')) {
      i++;
    } else if (!opensSubstitution(token)) {
      return { index: i, word: token };
    } else {
      const end = skipSubstitution(tokens, i);
      if (end.rest !== '') return { index: end.next - 1, word: end.rest };
      if (slot && !SHELL_OPERATORS.has(tokens[end.next] ?? '')) return NO_CANDIDATE;
      i = end.next;
    }
  }
  return NO_CANDIDATE;
}

/**
 * Walk from the script slot to the real script, stepping over a chained
 * launcher. `/usr/bin/env node /a/hooks/gsd-x.js` puts `node` in the script
 * slot, and `env FOO=bar node x.js` puts an assignment there; both chain on to
 * the token that follows.
 *
 * A chained launcher must be a BARE word carrying no path separator, which is
 * the shape `env` resolves an interpreter to. That restriction is what keeps
 * the walk from reading past a user's own script: in
 * `bash /home/u/bin/node /a/hooks/gsd-notes.md` the second token IS the script
 * and the third is its argument, so stepping over anything whose basename
 * merely reads as a launcher would classify that user hook as gsd-owned and
 * delete it on pull. A bare `node` is never a script path.
 *
 * The cost is a launcher chain written with an absolute interpreter path
 * (`env /usr/bin/node gsd-x.js`) staying unresolved, which returns `false` and
 * KEEPS the entry. That is the safe direction for this module.
 *
 * @param tokens - The whitespace-split command tokens.
 * @param from - Index to start scanning at (the token after the launcher).
 * @returns The script candidate, or `NO_CANDIDATE` when the chain runs out.
 */
function resolveScriptWord(tokens: string[], from: number): Candidate {
  let candidate = nextScriptWord(tokens, from, true);
  while (candidate.index >= 0) {
    const word = stripQuotes(candidate.word);
    const isBareLauncher =
      !word.includes('/') && !word.includes('\\') && KNOWN_LAUNCHER_BASENAMES.has(word);
    if (!isBareLauncher && !ENV_ASSIGNMENT.test(word)) return candidate;
    candidate = nextScriptWord(tokens, candidate.index + 1, true);
  }
  return NO_CANDIDATE;
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
 * - `/usr/bin/env node /a/hooks/gsd-x.js` (env launcher chain)
 * - `/a/hooks/gsd-x.js` (launcher-less, shebang executable)
 * - `"/abs/path/node" "/abs/path/gsd-x.js"` (launcher and script both quoted)
 * - `"$(for n in ... done)" "/a/hooks/gsd-x.js"` (gsd's inline node-resolver)
 *
 * Handled defensively, NOT observed from gsd (a launcher-template change is what
 * caused the incident this module exists for, so these fail toward keeping the
 * entry rather than dropping it):
 * - `` `command -v node` /a/hooks/gsd-x.js `` (backtick resolver)
 * - `sh -c "$(cat /a/x) && /a/hooks/gsd-x.js"` (substitution in argument position)
 * - `node $(pwd)/gsd-x.js` (substitution with the script path trailing it)
 *
 * Algorithm: split the command on whitespace, strip a balanced pair of
 * surrounding quotes from each candidate word, and skip any leading `KEY=value`
 * environment-assignment tokens. `nextScriptWord` then advances past flags,
 * shell operators, and whole `$(...)`/backtick substitutions. If the first word
 * it yields is itself the script (it carries a path and is not a known launcher
 * binary, or its basename already starts with `gsd-`), classify off that word's
 * basename directly. This covers launcher-less commands with or without trailing
 * args/flags. Otherwise that word is the launcher, and a second walk in script
 * position yields the script path, stepping over a chained launcher so
 * `/usr/bin/env node x.js` resolves past `node`. Return
 * `basename.startsWith(GSD_PREFIX)`.
 *
 * Classification always keys off the script word, never a later one, so a
 * trailing `gsd-`-prefixed ARGUMENT cannot mark a user script as gsd-owned. That
 * is what the script-slot rule in `nextScriptWord` protects: when a substitution
 * occupies the script slot, the result is unknowable and the walk stops there
 * rather than reading past it to the next argument.
 *
 * Fail-safe: if no script word is found the command is unparseable; return
 * `false` so a user entry is never silently dropped. Note that `false` is only
 * safe in that direction. For an entry gsd really did install, `false` means the
 * entry is treated as user state, which is why every unparseable shape above
 * falls back to reading a literal token rather than giving up outright.
 *
 * @param command - Raw `command` string from a hook entry.
 * @returns `true` if gsd-owned; `false` if user-authored or unparseable.
 */
export function isGsdHookEntry(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] === '') return false;

  // Skip leading KEY=value env-assignment tokens.
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i])) {
    i++;
  }

  const launcher = nextScriptWord(tokens, i, false);
  if (launcher.index < 0) return false;
  const first = stripQuotes(launcher.word);
  const firstBase = scriptBasename(first);
  const firstHasPath = first.includes('/') || first.includes('\\');

  // Launcher-less form: the first candidate word is itself the script. True when
  // it carries a path and is not a known launcher binary, or its basename already
  // starts with GSD_PREFIX. Covers `/a/hooks/gsd-x.js`, the same with trailing
  // args/flags, and a bare `gsd-x.js`.
  if ((firstHasPath && !KNOWN_LAUNCHER_BASENAMES.has(firstBase)) || first.startsWith(GSD_PREFIX)) {
    return firstBase.startsWith(GSD_PREFIX);
  }

  // Otherwise that word is the launcher and the script is the next candidate,
  // stepping over a chained launcher (`env node x.js`). A launcher with no
  // script -> false.
  const script = resolveScriptWord(tokens, launcher.index + 1);
  if (script.index < 0) return false;
  return scriptBasename(stripQuotes(script.word)).startsWith(GSD_PREFIX);
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
    if (isProtoPollutionKey(key)) continue;
    // Only a `hooks` key holding a plain non-null object is walked; every other
    // key (and an unrecognized `hooks` shape) passes through by reference.
    const hooksObj = key === 'hooks' ? asPlainObject(value) : null;
    if (hooksObj === null) {
      out[key] = value;
      continue;
    }
    const filteredHooks = filterHooksBlock(hooksObj);
    if (filteredHooks !== null) out[key] = filteredHooks;
  }
  return out;
}

/**
 * Filter every event key of one `hooks` block, dropping an event whose matcher
 * array empties out. Returns `null` when no event key survives (signal to the
 * caller to omit the `hooks` key entirely).
 *
 * @param hooksObj - The plain-object value of the `hooks` key.
 * @returns The filtered block, or `null` when it would be empty.
 */
function filterHooksBlock(hooksObj: Record<string, unknown>): Record<string, unknown> | null {
  const filteredHooks: Record<string, unknown> = {};
  for (const [event, matchers] of Object.entries(hooksObj)) {
    if (isProtoPollutionKey(event)) continue;
    const filtered = filterEventMatchers(matchers);
    if (filtered !== null) filteredHooks[event] = filtered;
  }
  return Object.keys(filteredHooks).length > 0 ? filteredHooks : null;
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
    if (isProtoPollutionKey(event)) continue;
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
    if (isProtoPollutionKey(event) || !Array.isArray(gsdMatchers)) continue;
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
