import { HOST } from '../../core/config.ts';
import { asPlainObject } from '../../sync/hooks-filter.ts';
import { normalizeNodePathsDeep } from '../../sync/settings-classify.ts';
import { valueAtPath, type NestedEntry } from '../../sync/settings-entries.ts';
import { blockedNestedEntries, type WrittenSettings } from '../../sync/settings-guard.ts';
import { warn } from '../../core/utils.ts';

/** The settings views `nestedCaptureEntries` reads. */
type NestedSources = {
  base: Record<string, unknown>;
  overrides: Record<string, unknown>;
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
 * New entries, at any depth, inside an object or array the repo already has. A
 * base capture leaves out an object entry whose parent path the base does not
 * hold as an object all the way down, and an array member whose array the host
 * file sets itself, pointing at `--host`; `clashed` reports any left out.
 *
 * @param sources - Base, host, merge and live settings.
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
  const failing = new Set<string>();
  const shadowed = new Set<string>();
  const kept: NestedEntry[] = [];
  for (const e of all) {
    const problem = useHost ? null : baseClash(sources, e);
    if (problem === null) kept.push(e);
    else failing.add(problem);
    if (useHost && shadowsBase(sources, e)) shadowed.add(e.path.join('.'));
  }
  for (const message of failing) warn(message);
  for (const label of shadowed) {
    warn(
      `hosts/${HOST}.json will carry this host's full ${label} list, so later edits to ` +
        `${label} in shared/settings.base.json will not reach this host`,
    );
  }
  return { entries: kept, clashed: failing.size > 0 };
}

/** Why a base capture cannot save `e`, or `null` when it can. */
function baseClash(sources: NestedSources, e: NestedEntry): string | null {
  if (e.element === true) {
    // With the host file silent here, the merge's array is the base's own.
    if (valueAtPath(sources.overrides, e.path) === undefined) return null;
    const label = e.path.join('.');
    return (
      `not saving new ${label} entries to shared/settings.base.json: hosts/${HOST}.json sets ` +
      `${label} itself, so the shared list never reaches this host; run ` +
      `'nomad capture-settings --host' to save them there`
    );
  }
  const prefix = firstNonObjectPrefix(sources.base, e.path.slice(0, -1));
  return prefix === null ? null : clashWarning(sources.base, prefix);
}

/** Whether a host capture of `e` copies a shared array the host file did not set. */
function shadowsBase(sources: NestedSources, e: NestedEntry): boolean {
  return e.element === true && valueAtPath(sources.overrides, e.path) === undefined;
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
 * Add each entry to `subset` at its full path, creating the objects along the
 * way. An array member is appended to a copy of the merge's array there, since
 * arrays replace on merge. A base capture normalizes node launcher paths.
 *
 * @param subset - The capture subset being built (mutated).
 * @param entries - Entries from `nestedCaptureEntries`.
 * @param merged - The base + host merge.
 * @param useHost - True when capturing into the host file.
 */
export function addNestedEntries(
  subset: Record<string, unknown>,
  entries: NestedEntry[],
  merged: Record<string, unknown>,
  useHost: boolean,
): void {
  for (const e of entries) {
    let node = subset;
    for (const seg of e.path.slice(0, -1)) {
      if (!Object.hasOwn(node, seg)) node[seg] = {};
      node = node[seg] as Record<string, unknown>;
    }
    const [last] = e.path.slice(-1);
    const value = useHost ? e.value : normalizeNodePathsDeep(e.value);
    if (e.element !== true) node[last] = value;
    else {
      if (!Object.hasOwn(node, last)) node[last] = [...(valueAtPath(merged, e.path) as unknown[])];
      (node[last] as unknown[]).push(value);
    }
  }
}
