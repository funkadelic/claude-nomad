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
import { settingValueHash, type WrittenSettings } from './settings-guard.ts';

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
function readRecord(): { keys: WrittenSettings; hookIds: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsWrittenPath(), 'utf8'));
    if (!isObject(parsed) || parsed.kind !== SETTINGS_WRITTEN_KIND || !isObject(parsed.keys)) {
      return null;
    }
    const { keys, hookIds } = parsed;
    return Object.values(keys).every((h) => typeof h === 'string')
      ? { keys: keys as WrittenSettings, hookIds }
      : null;
  } catch {
    return null;
  }
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
  const ids = readRecord()?.hookIds;
  return new Set(Array.isArray(ids) ? ids.filter((h): h is string => typeof h === 'string') : []);
}

/**
 * Record a hash of each top-level value of `written` (the object handed to
 * `writeJsonAtomic` for settings.json), stripped of gsd hook entries first
 * so a graft-restored `hooks` key never enters the record, plus a hash of
 * each hook entry's full content. Drops any previous
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
    writeJsonAtomic(path, { kind: SETTINGS_WRITTEN_KIND, keys, hookIds });
  } catch (err) {
    warn(`could not record the written settings keys: ${(err as Error).message}`);
  }
}
