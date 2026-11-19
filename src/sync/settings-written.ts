/**
 * Per-host record of the top-level settings values the last successful
 * settings write produced (as hashes, by key), so the settings guard can tell
 * a value nomad itself wrote (and the repo no longer carries) from a local
 * addition or a local edit.
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

import { settingsWrittenPath } from '../core/config.ts';
import { writeJsonAtomic } from '../core/utils.fs.ts';
import { warn } from '../core/utils.ts';
import { stripGsdHookEntries } from './hooks-filter.ts';
import { hookEntryContents } from './hooks-entries.ts';
import { nestedEntries } from './settings-entries.ts';
import { nestedEntryId, settingValueHash, type WrittenSettings } from './settings-guard.ts';

/**
 * Producer tag the reader requires, so a record from an older nomad (a bare
 * key array) or another writer reads as no record.
 */
export const SETTINGS_WRITTEN_KIND = 'settings-written/2';

/** True for a non-null, non-array object. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The parsed record, or `null` when there is nothing trustworthy: absent,
 * unreadable, malformed JSON, a missing or foreign `kind`, or a `keys` map
 * holding a non-string. Never throws.
 */
function readRecord(): { keys: WrittenSettings; hookIds: unknown; entryIds: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsWrittenPath(), 'utf8'));
    if (!isObject(parsed) || parsed.kind !== SETTINGS_WRITTEN_KIND || !isObject(parsed.keys)) {
      return null;
    }
    const { keys, hookIds, entryIds } = parsed;
    return Object.values(keys).every((h) => typeof h === 'string')
      ? { keys: keys as WrittenSettings, hookIds, entryIds }
      : null;
  } catch {
    return null;
  }
}

/** The string members of `v` when it is an array, else an empty set. */
function stringSet(v: unknown): ReadonlySet<string> {
  return new Set(Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string') : []);
}

/**
 * Read the record's key hashes, or `null` when there is nothing trustworthy
 * (see `readRecord`). `null` is the fail-safe value meaning "no record".
 */
export function readWrittenSettingsKeys(): WrittenSettings | null {
  return readRecord()?.keys ?? null;
}

/**
 * Hashes of the content of each gsd-stripped hook entry the last write
 * produced; empty for no record or a record written before these were kept.
 */
export function readWrittenHookIds(): ReadonlySet<string> {
  return stringSet(readRecord()?.hookIds);
}

/**
 * Hashes of each nested settings entry (path and value) the last write
 * produced; empty for no record or a record written before these were kept.
 */
export function readWrittenEntryIds(): ReadonlySet<string> {
  return stringSet(readRecord()?.entryIds);
}

/**
 * Record a hash of each top-level value of `written` (the object handed to
 * `writeJsonAtomic` for settings.json), stripped of gsd hook entries first
 * so a graft-restored `hooks` key never enters the record, plus a hash of
 * each hook entry's full content and of each nested object entry (path and
 * value) outside `hooks` and credential keys. Drops any previous
 * record before writing, so a failed write leaves none rather than a stale one.
 * Never throws: degrades to a warning on failure, since settings.json is
 * already written.
 */
export function recordWrittenSettingsKeys(written: Record<string, unknown>): void {
  try {
    const path = settingsWrittenPath();
    mkdirSync(dirname(path), { recursive: true });
    // Invalidate first: a stale record is over-permissive (its keys skip the
    // refusal guard), so a failed write must leave no record rather than the
    // previous write's keys.
    rmSync(path, { force: true });
    const keys = Object.fromEntries(
      Object.entries(stripGsdHookEntries(written)).map(([k, v]) => [k, settingValueHash(v)]),
    );
    const hookIds = [...hookEntryContents(written)].map(settingValueHash);
    const entryIds = nestedEntries(written).map((e) =>
      nestedEntryId(e.path, e.value, e.element === true),
    );
    writeJsonAtomic(path, { kind: SETTINGS_WRITTEN_KIND, keys, hookIds, entryIds });
  } catch (err) {
    warn(`could not record the written settings keys: ${(err as Error).message}`);
  }
}

/**
 * Add the nested entry ids of `preMerged` to the existing record after a
 * refused pull, so a capture still treats what the repo dropped as removed.
 * No record means no change. Never throws.
 * @param preMerged - The merge at the pre-pull HEAD.
 */
export function backfillWrittenEntryIds(preMerged: Record<string, unknown>): void {
  try {
    const record = readRecord();
    if (record === null) return;
    const ids = new Set(stringSet(record.entryIds));
    for (const e of nestedEntries(preMerged))
      ids.add(nestedEntryId(e.path, e.value, e.element === true));
    writeJsonAtomic(settingsWrittenPath(), {
      kind: SETTINGS_WRITTEN_KIND,
      ...record,
      entryIds: [...ids],
    });
  } catch (err) {
    warn(`could not update the written settings keys: ${(err as Error).message}`);
  }
}
