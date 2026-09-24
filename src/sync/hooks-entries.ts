/**
 * Entry-level identity for the `hooks` block of `settings.json`: flattens the
 * gsd-stripped block into individual (event, matcher, hook) entries so a live
 * entry the merge lacks can be diffed and named without touching the
 * top-level-key drift classifier.
 */

import { stripGsdHookEntries } from './hooks-filter.ts';
import { normalizeNodePathsDeep } from './settings-classify.ts';
import { sortKeysDeep } from '../core/utils.json.ts';

/**
 * One inner hook entry flattened out of a `hooks` block. `entry` is the
 * gsd-stripped matcher-entry object the inner `hook` came from (the same
 * reference for every inner hook of one matcher entry).
 */
export type HookEntry = {
  /** The event key the entry lives under, e.g. `PreToolUse`. */
  event: string;
  /** The matcher-entry object this hook belongs to. */
  entry: Record<string, unknown>;
  /** The raw inner hook value. */
  hook: unknown;
  /** Key-order-independent identity string; see `hookEntryId`. */
  id: string;
};

/**
 * Printable ASCII, 1 to 60 characters: a command this short and clean reads
 * safely in a terminal refusal message.
 */
const READABLE_COMMAND_RE = /^[ -~]{1,60}$/;

/**
 * Identity for one hook entry: a command hook keys off (event, matcher, type,
 * normalized command); every other inner-hook shape falls back to a
 * key-order-independent encoding of the whole hook value, so it still gets a
 * distinct identity rather than colliding with another entry.
 */
function hookEntryId(event: string, matcher: unknown, hook: unknown): string {
  const m = typeof matcher === 'string' ? matcher : '';
  if (hook !== null && typeof hook === 'object' && !Array.isArray(hook)) {
    const hookObj = hook as Record<string, unknown>;
    if (typeof hookObj.command === 'string') {
      return JSON.stringify([event, m, hookObj.type, normalizeNodePathsDeep(hookObj.command)]);
    }
  }
  return JSON.stringify([event, m, sortKeysDeep(normalizeNodePathsDeep(hook))]);
}

/**
 * Flatten one matcher entry's inner `hooks` array into `HookEntry` records.
 * Fail-safe: a non-object entry, or one whose `hooks` is not an array,
 * contributes nothing (mirrors `filterMatcherEntry`'s pass-through shapes).
 */
function flattenMatcherEntry(event: string, entry: unknown): HookEntry[] {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
  const entryObj = entry as Record<string, unknown>;
  if (!Array.isArray(entryObj.hooks)) return [];
  const matcher = entryObj.matcher;
  return (entryObj.hooks as unknown[]).map((hook) => ({
    event,
    entry: entryObj,
    hook,
    id: hookEntryId(event, matcher, hook),
  }));
}

/**
 * Flatten one event's matcher array into `HookEntry` records. Fail-safe: a
 * non-array `matchers` value contributes nothing.
 */
function flattenEventMatchers(event: string, matchers: unknown): HookEntry[] {
  if (!Array.isArray(matchers)) return [];
  const out: HookEntry[] = [];
  for (const entry of matchers) {
    out.push(...flattenMatcherEntry(event, entry));
  }
  return out;
}

/**
 * Flatten the gsd-stripped `hooks` block of `settings` into `HookEntry`
 * records, in document order. Event keys are proto-safe because they come
 * from `stripGsdHookEntries`, which already drops them.
 */
function flattenHookEntries(settings: Record<string, unknown>): HookEntry[] {
  const hooksVal = stripGsdHookEntries(settings).hooks;
  if (hooksVal === null || typeof hooksVal !== 'object' || Array.isArray(hooksVal)) return [];
  const out: HookEntry[] = [];
  for (const [event, matchers] of Object.entries(hooksVal as Record<string, unknown>)) {
    out.push(...flattenEventMatchers(event, matchers));
  }
  return out;
}

/**
 * Live-only hook entries: `existing` entries whose id `merged` lacks. Empty
 * unless the gsd-stripped `merged` has an own `hooks` key.
 * @param merged - The base + host merge about to be written.
 * @param existing - The parsed live settings.json.
 */
export function liveOnlyHookEntries(
  merged: Record<string, unknown>,
  existing: Record<string, unknown>,
): HookEntry[] {
  if (!Object.hasOwn(stripGsdHookEntries(merged), 'hooks')) return [];
  const mergedIds = hookEntryIds(merged);
  return flattenHookEntries(existing).filter((e) => !mergedIds.has(e.id));
}

/**
 * The identity ids of every gsd-stripped hook entry in `settings`.
 * @param settings - Any settings object (merge, live file, or pre-pull merge).
 */
export function hookEntryIds(settings: Record<string, unknown>): Set<string> {
  return new Set(flattenHookEntries(settings).map((e) => e.id));
}

/**
 * Human-readable label for a blocked hook entry: names the command when it is
 * short, printable ASCII, else just the event, so a long or control-character
 * command never reaches the terminal.
 * @param e - A hook entry, typically from `liveOnlyHookEntries`.
 */
export function hookEntryLabel(e: HookEntry): string {
  if (e.hook !== null && typeof e.hook === 'object' && !Array.isArray(e.hook)) {
    const cmd = (e.hook as Record<string, unknown>).command;
    if (typeof cmd === 'string' && READABLE_COMMAND_RE.test(cmd)) {
      return `${e.event} hook '${cmd}'`;
    }
  }
  return `${e.event} hook`;
}
