/**
 * Per-host record of the top-level settings keys the last successful
 * settings write produced, so the settings guard can tell a key nomad
 * itself wrote (and the repo no longer carries) from a local addition.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { settingsWrittenPath } from '../core/config.ts';
import { writeJsonAtomic } from '../core/utils.fs.ts';
import { warn } from '../core/utils.ts';
import { stripGsdHookEntries } from './hooks-filter.ts';

/**
 * Read the record, or `null` when there is nothing trustworthy: absent,
 * unreadable, malformed JSON, not an array, or an array holding a
 * non-string. `null` is the fail-safe value meaning "no record". Never
 * throws.
 */
export function readWrittenSettingsKeys(): readonly string[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsWrittenPath(), 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every((k): k is string => typeof k === 'string')) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Record the top-level keys of `written` (the object handed to
 * `writeJsonAtomic` for settings.json), stripped of gsd hook entries first
 * so a graft-restored `hooks` key never enters the record. Never throws:
 * degrades to a warning on failure, since settings.json is already written.
 */
export function recordWrittenSettingsKeys(written: Record<string, unknown>): void {
  try {
    const path = settingsWrittenPath();
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, Object.keys(stripGsdHookEntries(written)));
  } catch (err) {
    warn(`could not record the written settings keys: ${(err as Error).message}`);
  }
}
