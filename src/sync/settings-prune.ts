import { isProtoPollutionKey } from '../core/utils.json.ts';
import { asPlainObject } from './hooks-filter.ts';
import { elementEntry, sameValue, type NestedEntry } from './settings-entries.ts';

/** Whether the last settings write produced this entry. */
type WasWritten = (e: NestedEntry) => boolean;

/** `arr` (at `path`) without the members the last write produced, each appended to `removed`. */
function pruneArray(
  path: string[],
  arr: unknown[],
  wasWritten: WasWritten,
  removed: NestedEntry[],
): unknown[] {
  const gone: unknown[] = [];
  return arr.filter((value, i) => {
    const e = elementEntry(path, value, i + 1);
    if (!wasWritten(e)) return true;
    if (!gone.some((g) => sameValue(g, value))) {
      gone.push(value);
      removed.push(e);
    }
    return false;
  });
}

/** `value` (at `path`) with written descendants or members pruned; a scalar is returned as is. */
function pruneValue(
  path: string[],
  value: unknown,
  wasWritten: WasWritten,
  removed: NestedEntry[],
): unknown {
  const obj = asPlainObject(value);
  if (obj !== null) return pruneWritten(path, obj, wasWritten, removed);
  return Array.isArray(value) ? pruneArray(path, value, wasWritten, removed) : value;
}

/** Whether a pruned container is left with nothing in it. */
function isEmpty(value: unknown): boolean {
  return Array.isArray(value) ? value.length === 0 : Object.keys(value as object).length === 0;
}

/**
 * Copy of `obj` (at `path`) without any descendant the last write produced;
 * each such descendant, removed whole, is appended to `removed`.
 */
function pruneWritten(
  path: string[],
  obj: Record<string, unknown>,
  wasWritten: WasWritten,
  removed: NestedEntry[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [sub, value] of Object.entries(obj)) {
    if (isProtoPollutionKey(sub)) continue;
    const full = [...path, sub];
    const e: NestedEntry = { path: full, key: full[0], label: full.join('.'), value };
    if (wasWritten(e)) {
      removed.push(e);
      continue;
    }
    const before = removed.length;
    const kept = pruneValue(full, value, wasWritten, removed);
    // A child emptied by pruning held only written entries, so it goes too.
    if (removed.length === before || !isEmpty(kept)) out[sub] = kept;
  }
  return out;
}

/**
 * Drop, from each blocked entry's value, the descendants the last write
 * produced (the repo removed them, so a capture must not save them back) and
 * report them as removed. A blocked entry left empty by that moves whole to
 * `removed`. The live settings object is not mutated.
 *
 * @param split - The blocked/removed partition of live-only entries.
 * @param wasWritten - Whether the last write produced an entry.
 * @returns The partition with written descendants moved to `removed`, sorted by label.
 */
export function pruneBlockedEntries(
  split: { blocked: NestedEntry[]; removed: NestedEntry[] },
  wasWritten: WasWritten,
): { blocked: NestedEntry[]; removed: NestedEntry[] } {
  const blocked: NestedEntry[] = [];
  const removed = [...split.removed];
  for (const e of split.blocked) {
    const dropped: NestedEntry[] = [];
    const value = e.element === true ? e.value : pruneValue(e.path, e.value, wasWritten, dropped);
    if (dropped.length === 0) blocked.push(e);
    else if (isEmpty(value)) removed.push(e);
    else {
      blocked.push({ ...e, value });
      removed.push(...dropped);
    }
  }
  removed.sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
  return { blocked, removed };
}
