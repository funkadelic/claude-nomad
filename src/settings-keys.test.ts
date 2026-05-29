import { describe, expect, it } from 'vitest';

import { canonicalizeKeys, parseKeyArray } from '../scripts/sync-settings-keys.ts';
import { APP_ONLY_KEYS, KNOWN_SETTINGS_KEYS, SCHEMA_KEYS } from './settings-keys.ts';

/**
 * Offline guards for the settings-keys module and its generator. No network:
 * these assert the committed arrays are already in the canonical shape the
 * generator produces (sorted case-insensitively, deduped) and that the two
 * provenance groups stay disjoint, so a real `sync-settings-keys.ts` run
 * against an unchanged schema is a no-op diff.
 */
describe('settings-keys canonical shape', () => {
  it('SCHEMA_KEYS is already canonical (regenerate-from-self is a no-op)', () => {
    expect(canonicalizeKeys(SCHEMA_KEYS)).toEqual(SCHEMA_KEYS);
  });

  it('APP_ONLY_KEYS is already canonical', () => {
    expect(canonicalizeKeys(APP_ONLY_KEYS)).toEqual(APP_ONLY_KEYS);
  });

  it('SCHEMA_KEYS and APP_ONLY_KEYS are disjoint by design', () => {
    const overlap = SCHEMA_KEYS.filter((k) => APP_ONLY_KEYS.includes(k));
    expect(overlap).toEqual([]);
  });

  it('KNOWN_SETTINGS_KEYS is the union of both groups', () => {
    expect(KNOWN_SETTINGS_KEYS.size).toBe(SCHEMA_KEYS.length + APP_ONLY_KEYS.length);
    for (const k of [...SCHEMA_KEYS, ...APP_ONLY_KEYS])
      expect(KNOWN_SETTINGS_KEYS.has(k)).toBe(true);
  });
});

describe('sync-settings-keys parseKeyArray', () => {
  it('round-trips the SCHEMA_KEYS literal back out of the source', () => {
    const source = `export const SCHEMA_KEYS = [\n  'model',\n  'env',\n];\n`;
    expect(parseKeyArray(source, 'SCHEMA_KEYS')).toEqual(['model', 'env']);
  });

  it('throws a clear error when the named array is absent', () => {
    expect(() => parseKeyArray('const OTHER = [];', 'SCHEMA_KEYS')).toThrow(
      /could not find SCHEMA_KEYS/,
    );
  });
});
