import { isProtoPollutionKey } from '../core/utils.json.ts';
import { asPlainObject } from './hooks-filter.ts';
import { elementEntry, type NestedEntry } from './settings-entries.ts';

/** Whether the last settings write produced this entry. */
type WasWritten = (e: NestedEntry) => boolean;

/** `arr` (at `path`) without the members the last write produced, each appended to `removed`. */
function pruneArray(
  path: string[],
  arr: unknown[],
  wasWritten: WasWritten,
  removed: NestedEntry[],
): unknown[] {
  return arr.filter((value) => {
    const e = elementEntry(path, value);
    if (!wasWritten(e)) return true;
    if (!removed.some((r) => r.label === e.label)) removed.push(e);
    return false;
  });
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
    const child = asPlainObject(value);
    if (child === null) {
      out[sub] = Array.isArray(value) ? pruneArray(full, value, wasWritten, removed) : value;
      continue;
    }
    const before = removed.length;
    const kept = pruneWritten(full, child, wasWritten, removed);
    // A child emptied by pruning held only written entries, so it goes too.
    if (removed.length === before || Object.keys(kept).length > 0) out[sub] = kept;
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
    const obj = e.element === true ? null : asPlainObject(e.value);
    const dropped: NestedEntry[] = [];
    const value = obj === null ? e.value : pruneWritten(e.path, obj, wasWritten, dropped);
    if (dropped.length === 0) blocked.push(e);
    else if (Object.keys(value as object).length === 0) removed.push(e);
    else {
      blocked.push({ ...e, value });
      removed.push(...dropped);
    }
  }
  removed.sort((a, b) => a.label.localeCompare(b.label, 'en'));
  return { blocked, removed };
}
