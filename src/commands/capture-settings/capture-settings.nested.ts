import { HOST } from '../../core/config.ts';
import { asPlainObject } from '../../sync/hooks-filter.ts';
import {
  normalizeNodePathsDeep,
  valueAtPath,
  type NestedEntry,
} from '../../sync/settings-classify.ts';
import { blockedNestedEntries, type WrittenSettings } from '../../sync/settings-guard.ts';
import { warn } from '../../core/utils.ts';

/** The settings views `nestedCaptureEntries` reads. */
type NestedSources = {
  base: Record<string, unknown>;
  merged: Record<string, unknown>;
  settings: Record<string, unknown>;
};

/**
 * The first prefix of `parent` (as a path) the base does not hold as an object,
 * or `null` when the whole chain is objects.
 */
function firstNonObjectPrefix(base: Record<string, unknown>, parent: string[]): string[] | null {
  for (let i = 1; i <= parent.length; i++) {
    const prefix = parent.slice(0, i);
    if (asPlainObject(valueAtPath(base, prefix)) === null) return prefix;
  }
  return null;
}

/**
 * New entries, at any depth, inside an object the repo already has. A base
 * capture leaves out any whose parent path the base does not hold as an object
 * all the way down (saving would replace that value, or add a path only the host
 * file has for every host) and points at `--host`; `clashed` reports any left
 * out. The non-object message names the failing prefix, which for a one-level
 * entry is the top-level key.
 *
 * @param sources - Base, merge and live settings.
 * @param useHost - True when capturing into the host file (never clashes).
 * @param written - The written-settings record, or `null`.
 * @param entryIds - Hashes of each nested entry from the last write.
 * @returns The entries to save and whether any were left out.
 */
export function nestedCaptureEntries(
  sources: NestedSources,
  useHost: boolean,
  written: WrittenSettings | null,
  entryIds: ReadonlySet<string>,
): { entries: NestedEntry[]; clashed: boolean } {
  const all = blockedNestedEntries(sources.merged, sources.settings, {}, written, entryIds);
  // With --host the merge holds each path as an object, so the host file cannot clash.
  if (useHost) return { entries: all, clashed: false };
  const failing = new Set<string>();
  const kept: NestedEntry[] = [];
  for (const e of all) {
    const prefix = firstNonObjectPrefix(sources.base, e.path.slice(0, -1));
    if (prefix === null) kept.push(e);
    else failing.add(clashWarning(sources.base, prefix));
  }
  for (const message of failing) warn(message);
  return { entries: kept, clashed: failing.size > 0 };
}

/** The warning for new entries under `prefix`, the first path the base does not hold as an object. */
function clashWarning(base: Record<string, unknown>, prefix: string[]): string {
  const label = prefix.join('.');
  const why =
    valueAtPath(base, prefix) === undefined
      ? `only hosts/${HOST}.json has ${label}, so saving would add it for every host`
      : `it sets ${label} to a value that is not an object, which saving would replace`;
  return (
    `not saving new ${label} entries to shared/settings.base.json: ${why}; run ` +
    `'nomad capture-settings --host' to save them there`
  );
}

/**
 * Add each entry to `subset` at its full path, creating the objects along the way.
 * A base capture normalizes node launcher paths; a host capture keeps them raw.
 *
 * @param subset - The capture subset being built (mutated).
 * @param entries - Entries from `nestedCaptureEntries`.
 * @param useHost - True when capturing into the host file.
 */
export function addNestedEntries(
  subset: Record<string, unknown>,
  entries: NestedEntry[],
  useHost: boolean,
): void {
  for (const e of entries) {
    let node = subset;
    for (const seg of e.path.slice(0, -1)) {
      if (!Object.hasOwn(node, seg)) node[seg] = {};
      node = node[seg] as Record<string, unknown>;
    }
    const [last] = e.path.slice(-1);
    node[last] = useHost ? e.value : normalizeNodePathsDeep(e.value);
  }
}
