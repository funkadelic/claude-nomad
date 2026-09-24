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

// ---------------------------------------------------------------------------
// Capture subset (nomad capture-settings)
// ---------------------------------------------------------------------------

/** Sources `buildHookCaptureSubset` reads from. */
export type HookCaptureSources = {
  /** `shared/settings.base.json`. */
  base: Record<string, unknown>;
  /** `hosts/<HOST>.json`, or `{}` when absent. */
  overrides: Record<string, unknown>;
  /** `deepMerge(base, overrides)`. */
  merged: Record<string, unknown>;
  /** The parsed live `settings.json`. */
  settings: Record<string, unknown>;
};

/** Result of `buildHookCaptureSubset`. */
export type HookCaptureResult = {
  /** Per-event FULL array to write into the capture destination. */
  hooks: Record<string, unknown[]>;
  /** Host-capture events the host file did not set before this capture. */
  shadowed: string[];
  /** Base-capture events skipped because the host file sets them itself. */
  skipped: string[];
};

/**
 * The plain-object `hooks` value of `settings`, or `{}` for any other shape.
 */
function hooksBlockOf(settings: Record<string, unknown>): Record<string, unknown> {
  const v = settings.hooks;
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Group live-only hook entries by event, in first-seen (live document) order.
 */
function groupByEvent(entries: HookEntry[]): Map<string, HookEntry[]> {
  const out = new Map<string, HookEntry[]>();
  for (const e of entries) {
    const list = out.get(e.event);
    if (list) list.push(e);
    else out.set(e.event, [e]);
  }
  return out;
}

/**
 * Build one appended matcher entry per distinct source matcher entry in
 * `entries` (grouped by `entry` object identity), each narrowed to its
 * live-only inner hooks: `{ ...entry, hooks: [its live-only inner hooks] }`,
 * in live order.
 */
function appendedMatcherEntries(entries: HookEntry[]): Record<string, unknown>[] {
  const byEntry = new Map<Record<string, unknown>, unknown[]>();
  for (const e of entries) {
    const inner = byEntry.get(e.entry);
    if (inner) inner.push(e.hook);
    else byEntry.set(e.entry, [e.hook]);
  }
  return [...byEntry.entries()].map(([entry, hooksArr]) => ({ ...entry, hooks: hooksArr }));
}

/**
 * Base-destination capture: appends normalized live-only entries to the
 * base's own array per event; skips (into `skipped`) an event the host file
 * sets itself, since its array would hide the base addition.
 */
function buildBaseHookCapture(sources: HookCaptureSources): HookCaptureResult {
  const liveOnly = liveOnlyHookEntries(sources.merged, sources.settings);
  const baseHooks = hooksBlockOf(sources.base);
  const hostHooks = hooksBlockOf(sources.overrides);
  const hooks: Record<string, unknown[]> = {};
  const skipped: string[] = [];
  for (const [event, entries] of groupByEvent(liveOnly)) {
    if (Object.hasOwn(hostHooks, event)) {
      skipped.push(event);
      continue;
    }
    const priorArr = Array.isArray(baseHooks[event]) ? (baseHooks[event] as unknown[]) : [];
    const appended = appendedMatcherEntries(entries).map(
      (entry) => normalizeNodePathsDeep(entry) as Record<string, unknown>,
    );
    hooks[event] = [...priorArr, ...appended];
  }
  return { hooks, shadowed: [], skipped };
}

/**
 * The prior array for one host-capture event: the host file's own array when
 * it set one, else the gsd-stripped merged array (or `[]`); also reports
 * whether the host file set the event itself.
 */
function hostPriorArray(
  hostHooks: Record<string, unknown>,
  mergedHooks: Record<string, unknown>,
  event: string,
): { array: unknown[]; setByHost: boolean } {
  const hostArr = hostHooks[event];
  if (Array.isArray(hostArr)) return { array: hostArr, setByHost: true };
  const mergedArr = mergedHooks[event];
  return { array: Array.isArray(mergedArr) ? mergedArr : [], setByHost: false };
}

/**
 * Host-destination capture: writes the FULL event array (prior entries plus
 * the live-only ones), unnormalized. Reports an event as `shadowed` when the
 * host file did not set it and the gsd-stripped merged array was non-empty.
 */
function buildHostHookCapture(sources: HookCaptureSources): HookCaptureResult {
  const liveOnly = liveOnlyHookEntries(sources.merged, sources.settings);
  const hostHooks = hooksBlockOf(sources.overrides);
  const mergedHooks = hooksBlockOf(stripGsdHookEntries(sources.merged));
  const hooks: Record<string, unknown[]> = {};
  const shadowed: string[] = [];
  for (const [event, entries] of groupByEvent(liveOnly)) {
    const { array: priorArr, setByHost } = hostPriorArray(hostHooks, mergedHooks, event);
    if (!setByHost && priorArr.length > 0) shadowed.push(event);
    hooks[event] = [...priorArr, ...appendedMatcherEntries(entries)];
  }
  return { hooks, shadowed, skipped: [] };
}

/** Per-event hook-entry subset `nomad capture-settings` writes to the destination. */
export function buildHookCaptureSubset(
  sources: HookCaptureSources,
  useHost: boolean,
): HookCaptureResult {
  // eslint-disable-next-line sonarjs/no-selector-parameter -- mirrors buildCaptureSubset's caller
  return useHost ? buildHostHookCapture(sources) : buildBaseHookCapture(sources);
}
