/**
 * Settings entries below the top level: object entries addressed by their full
 * key path, and array members (`element`), which count as a set by deep
 * equality because arrays replace rather than merge.
 */

import { createHash } from 'node:crypto';

import { isProtoPollutionKey } from '../core/utils.json.ts';
import { asPlainObject, stripGsdHookEntries } from './hooks-filter.ts';
import { CAPTURE_EXCLUDED_KEYS, deepEqual, normalizeNodePathsDeep } from './settings-classify.ts';

/**
 * An entry below the top level. An object entry's `path` ends at its own key;
 * an `element` entry's `path` is the array it belongs to and `value` is the member.
 */
export type NestedEntry = {
  path: string[];
  key: string;
  label: string;
  value: unknown;
  element?: true;
};

/**
 * The value at `path` through own plain-object properties, else `undefined`.
 * @param obj - The object to read from.
 * @param path - Key segments from the top level down.
 */
export function valueAtPath(obj: Record<string, unknown>, path: readonly string[]): unknown {
  let node: unknown = obj;
  for (const seg of path) {
    const cur = asPlainObject(node);
    if (cur === null || !Object.hasOwn(cur, seg)) return undefined;
    node = cur[seg];
  }
  return node;
}

/**
 * Deep equality after node launcher paths are normalized, as drift compares.
 * @param a - First value.
 * @param b - Second value.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  return deepEqual(normalizeNodePathsDeep(a), normalizeNodePathsDeep(b));
}

/**
 * Whether `obj` holds `e`: the same value at its path, or for an element, an
 * equal member of the array there.
 * @param obj - A settings object, such as a merge.
 * @param e - The entry to look for.
 */
export function holdsEntry(obj: Record<string, unknown>, e: NestedEntry): boolean {
  const at = valueAtPath(obj, e.path);
  if (e.element !== true) return sameValue(at, e.value);
  return Array.isArray(at) && at.some((v) => sameValue(v, e.value));
}

/** 1 to 200 characters with no control, format (bidi, zero-width) or line-separator characters. */
const READABLE_MEMBER_RE = /^[^\p{Cc}\p{Cf}\u2028\u2029]{1,200}$/u;

/** JSON with object keys sorted, so key order never changes a hash. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    const obj = asPlainObject(v);
    return obj === null
      ? v
      : Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1)));
  });
}

/**
 * The entry for `value` as member `position` (1-based) of the array at `path`.
 * The label shows a readable member in full, else its position and a hash
 * prefix, so no long or control-character value reaches the terminal.
 * @param path - The array's key path.
 * @param value - The member.
 * @param position - The member's 1-based position in that array.
 */
export function elementEntry(path: string[], value: unknown, position: number): NestedEntry {
  const json = JSON.stringify(value);
  const text = typeof value === 'string' ? value : json;
  const hash = createHash('sha256').update(canonicalJson(normalizeNodePathsDeep(value)));
  const shown = READABLE_MEMBER_RE.test(text)
    ? json
    : `item ${position}, ${hash.digest('hex').slice(0, 8)}`;
  return { path, key: path[0], label: `${path.join('.')}[${shown}]`, value, element: true };
}

/** Push one element entry per distinct member of `arr`, the array at `path`. */
function collectElements(path: string[], arr: unknown[], out: NestedEntry[]): void {
  const seen: unknown[] = [];
  for (const [i, value] of arr.entries()) {
    if (seen.some((s) => sameValue(s, value))) continue;
    seen.push(value);
    out.push(elementEntry(path, value, i + 1));
  }
}

/** Push one entry per sub-key of `obj` at `path`, recursing into objects and arrays. */
function collectEntries(obj: Record<string, unknown>, path: string[], out: NestedEntry[]): void {
  for (const [sub, value] of Object.entries(obj)) {
    if (isProtoPollutionKey(sub)) continue;
    const full = [...path, sub];
    out.push({ path: full, key: full[0], label: full.join('.'), value });
    const child = asPlainObject(value);
    if (child !== null) collectEntries(child, full, out);
    else if (Array.isArray(value)) collectElements(full, value, out);
  }
}

/**
 * Every object sub-path under top-level objects, plus one element per distinct
 * array member; skips `hooks`, credential keys and prototype-pollution names.
 * @param settings - A parsed settings object.
 * @returns One entry per sub-key or array member, parents before children.
 */
export function nestedEntries(settings: Record<string, unknown>): NestedEntry[] {
  const out: NestedEntry[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'hooks' || CAPTURE_EXCLUDED_KEYS.has(key) || isProtoPollutionKey(key)) continue;
    const obj = asPlainObject(value);
    if (obj !== null) collectEntries(obj, [key], out);
    else if (Array.isArray(value)) collectElements([key], value, out);
  }
  return out;
}

/** Whether `e` is live-only against `merged`: its container exists there and lacks it. */
function missingFrom(merged: Record<string, unknown>, e: NestedEntry): boolean {
  if (e.element === true)
    return Array.isArray(valueAtPath(merged, e.path)) && !holdsEntry(merged, e);
  const parent = asPlainObject(valueAtPath(merged, e.path.slice(0, -1)));
  const [last] = e.path.slice(-1);
  return parent !== null && !Object.hasOwn(parent, last);
}

/**
 * Live-only entries inside an object or array the merge also carries (a new
 * marketplace, a rule added to `permissions.allow`), sorted by label.
 * @param merged - Recomputed `deepMerge(base, host)` object.
 * @param settings - Parsed `~/.claude/settings.json` object.
 */
export function liveOnlyNestedEntries(
  merged: Record<string, unknown>,
  settings: Record<string, unknown>,
): NestedEntry[] {
  const mergedObj = stripGsdHookEntries(merged);
  return nestedEntries(stripGsdHookEntries(settings))
    .filter((e) => missingFrom(mergedObj, e))
    .sort((a, b) => a.label.localeCompare(b.label, 'en'));
}

/** Copy of `obj` with the value at `path` replaced by `fn(value)`, copying each level. */
function updateAt(
  obj: Record<string, unknown>,
  path: readonly string[],
  fn: (value: unknown) => unknown,
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (!Object.hasOwn(obj, head)) return obj;
  if (rest.length === 0) return { ...obj, [head]: fn(obj[head]) };
  const child = asPlainObject(obj[head]);
  return child === null ? obj : { ...obj, [head]: updateAt(child, rest, fn) };
}

/** Copy of `obj` without `e`; an absent or non-object parent leaves it as is. */
function withoutEntry(obj: Record<string, unknown>, e: NestedEntry): Record<string, unknown> {
  if (e.element === true) {
    // Element entries come from the live array at this path, so it is an array.
    return updateAt(obj, e.path, (arr) => (arr as unknown[]).filter((v) => !sameValue(v, e.value)));
  }
  const [last] = e.path.slice(-1);
  return updateAt(obj, e.path.slice(0, -1), (p) => {
    const parent = asPlainObject(p);
    return parent === null
      ? p
      : Object.fromEntries(Object.entries(parent).filter(([k]) => k !== last));
  });
}

/**
 * A copy of `settings` without the given entries, so drift on their parent key
 * shows only edits a pull would overwrite.
 * @param settings - Parsed `~/.claude/settings.json` object.
 * @param entries - Entries from `liveOnlyNestedEntries`.
 */
export function withoutNestedEntries(
  settings: Record<string, unknown>,
  entries: NestedEntry[],
): Record<string, unknown> {
  return entries.reduce((acc, e) => withoutEntry(acc, e), settings);
}
