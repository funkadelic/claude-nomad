import { describe, expect, it } from 'vitest';

import { ALWAYS_NEVER_SYNC } from './config.ts';
import {
  buildCaptureSubset,
  CAPTURE_EXCLUDED_KEYS,
  classifySettingsDrift,
  normalizeNodePathsDeep,
} from './commands.capture-settings.core.ts';

/**
 * Behavior tests for the pure direction-aware settings drift core.
 *
 * Covers:
 * - classifySettingsDrift: behind/ahead/changed buckets and sort order.
 * - buildCaptureSubset: ahead-only promotion, secret exclusion, node-path normalization.
 * - normalizeNodePathsDeep: absolute-path matching, bare-string pass-through, recursion.
 * - CAPTURE_EXCLUDED_KEYS parity with ALWAYS_NEVER_SYNC.
 */

// ---------------------------------------------------------------------------
// classifySettingsDrift
// ---------------------------------------------------------------------------

describe('classifySettingsDrift', () => {
  it('returns behind for merged keys absent from settings', () => {
    const drift = classifySettingsDrift({ a: 1, b: 2 }, { a: 1 });
    expect(drift.behind).toEqual(['b']);
    expect(drift.ahead).toEqual([]);
    expect(drift.changed).toEqual([]);
  });

  it('returns ahead for settings keys absent from merged', () => {
    const drift = classifySettingsDrift({ a: 1 }, { a: 1, c: 3 });
    expect(drift.behind).toEqual([]);
    expect(drift.ahead).toEqual(['c']);
    expect(drift.changed).toEqual([]);
  });

  it('returns changed for keys in both with deep-different scalar values', () => {
    const drift = classifySettingsDrift({ a: 1 }, { a: 2 });
    expect(drift.behind).toEqual([]);
    expect(drift.ahead).toEqual([]);
    expect(drift.changed).toEqual(['a']);
  });

  it('example from plan: merged {a,b}, settings {a,c} -> behind b, ahead c', () => {
    const drift = classifySettingsDrift({ a: 1, b: 2 }, { a: 1, c: 3 });
    expect(drift.behind).toEqual(['b']);
    expect(drift.ahead).toEqual(['c']);
    expect(drift.changed).toEqual([]);
  });

  it('classifies a key with deep-different value as changed, not behind/ahead', () => {
    const drift = classifySettingsDrift({ a: { x: 1 } }, { a: { x: 2 } });
    expect(drift.changed).toEqual(['a']);
    expect(drift.behind).toEqual([]);
    expect(drift.ahead).toEqual([]);
  });

  it('treats arrays with different elements as changed', () => {
    const drift = classifySettingsDrift({ a: [1, 2] }, { a: [1, 3] });
    expect(drift.changed).toEqual(['a']);
  });

  it('treats arrays with different lengths as changed', () => {
    const drift = classifySettingsDrift({ a: [1] }, { a: [1, 2] });
    expect(drift.changed).toEqual(['a']);
  });

  it('treats equal arrays as unchanged (no bucket)', () => {
    const drift = classifySettingsDrift({ a: [1, 2] }, { a: [1, 2] });
    expect(drift.behind).toEqual([]);
    expect(drift.ahead).toEqual([]);
    expect(drift.changed).toEqual([]);
  });

  it('sorts each bucket by locale compare en', () => {
    const drift = classifySettingsDrift({ b: 1, a: 1, c: 1 }, { z: 1, y: 1, x: 1 });
    expect(drift.behind).toEqual(['a', 'b', 'c']);
    expect(drift.ahead).toEqual(['x', 'y', 'z']);
  });

  it('returns empty buckets for identical objects', () => {
    const drift = classifySettingsDrift({ a: 1, b: 'two' }, { a: 1, b: 'two' });
    expect(drift.behind).toEqual([]);
    expect(drift.ahead).toEqual([]);
    expect(drift.changed).toEqual([]);
  });

  it('handles null values: equal null is not changed', () => {
    const drift = classifySettingsDrift({ a: null }, { a: null });
    expect(drift.changed).toEqual([]);
  });

  it('handles null value in merged vs non-null in settings as changed', () => {
    const drift = classifySettingsDrift({ a: null }, { a: 1 });
    expect(drift.changed).toEqual(['a']);
  });

  it('handles nested object deep equality correctly', () => {
    const drift = classifySettingsDrift(
      { a: { nested: { deep: true } } },
      { a: { nested: { deep: true } } },
    );
    expect(drift.changed).toEqual([]);
  });

  it('treats objects with different key counts as changed', () => {
    // Exercises objectsEqual length branch (aKeys.length !== bKeys.length)
    const drift = classifySettingsDrift({ a: { x: 1 } }, { a: { x: 1, y: 2 } });
    expect(drift.changed).toEqual(['a']);
  });

  it('treats objects with same count but different keys as changed', () => {
    // Exercises objectsEqual Object.hasOwn branch (key present in a but not in b)
    const drift = classifySettingsDrift({ a: { x: 1 } }, { a: { z: 1 } });
    expect(drift.changed).toEqual(['a']);
  });

  it('treats array vs non-array as changed (mismatched shape)', () => {
    // Exercises deepEqual Array.isArray(a) || Array.isArray(b) branch (line 64)
    const drift = classifySettingsDrift({ a: [1, 2] }, { a: { 0: 1, 1: 2 } });
    expect(drift.changed).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// normalizeNodePathsDeep
// ---------------------------------------------------------------------------

describe('normalizeNodePathsDeep', () => {
  it('normalizes absolute posix path ending in bin/node to bare node', () => {
    expect(normalizeNodePathsDeep('/home/user/.nvm/versions/node/v20/bin/node')).toBe('node');
  });

  it('normalizes /usr/bin/node to bare node', () => {
    expect(normalizeNodePathsDeep('/usr/bin/node')).toBe('node');
  });

  it('leaves bare node string unchanged', () => {
    expect(normalizeNodePathsDeep('node')).toBe('node');
  });

  it('leaves npx unchanged', () => {
    expect(normalizeNodePathsDeep('npx')).toBe('npx');
  });

  it('leaves nodejs unchanged (not the node binary)', () => {
    expect(normalizeNodePathsDeep('nodejs')).toBe('nodejs');
  });

  it('recurses into arrays', () => {
    const result = normalizeNodePathsDeep(['/usr/bin/node', 'npx', '--version']);
    expect(result).toEqual(['node', 'npx', '--version']);
  });

  it('recurses into nested objects', () => {
    const input = { command: '/home/user/.nvm/versions/node/v20/bin/node', args: ['--version'] };
    const result = normalizeNodePathsDeep(input);
    expect(result).toEqual({ command: 'node', args: ['--version'] });
  });

  it('recurses into deeply nested structures (hooks command value)', () => {
    const input = {
      hooks: {
        PreToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: '/usr/local/bin/node' }] },
        ],
      },
    };
    const result = normalizeNodePathsDeep(input) as typeof input;
    expect(
      (result as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } }).hooks.PreToolUse[0]
        .hooks[0].command,
    ).toBe('node');
  });

  it('passes null through unchanged', () => {
    expect(normalizeNodePathsDeep(null)).toBe(null);
  });

  it('passes numbers through unchanged', () => {
    expect(normalizeNodePathsDeep(42)).toBe(42);
  });

  it('matches windows-style path separator before node', () => {
    expect(normalizeNodePathsDeep('C:\\Program Files\\nodejs\\bin\\node')).toBe('node');
  });
});

// ---------------------------------------------------------------------------
// buildCaptureSubset
// ---------------------------------------------------------------------------

describe('buildCaptureSubset', () => {
  it('returns only ahead keys', () => {
    const merged = { a: 1 };
    const settings = { a: 1, b: 2 };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({ b: 2 });
  });

  it('excludes merged keys (not ahead)', () => {
    const merged = { a: 1, b: 2 };
    const settings = { a: 1, b: 2 };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({});
  });

  it('excludes changed keys (value differs, not a new key)', () => {
    const merged = { a: 1 };
    const settings = { a: 99 };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({});
  });

  it('excludes CAPTURE_EXCLUDED_KEYS even when locally-only (secret exclusion)', () => {
    // history.jsonl is a ALWAYS_NEVER_SYNC member
    const merged = { a: 1 };
    const settings = { a: 1, 'history.jsonl': 'sensitive' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).not.toHaveProperty('history.jsonl');
    expect(subset).toEqual({});
  });

  it('excludes .credentials.json from capture', () => {
    const merged = {};
    const settings = { '.credentials.json': 'secret' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({});
  });

  it('excludes settings.local.json from capture', () => {
    const merged = {};
    const settings = { 'settings.local.json': 'host-local' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({});
  });

  it('excludes .claude.json from capture', () => {
    const merged = {};
    const settings = { '.claude.json': 'oauth' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({});
  });

  it('excludes stats-cache.json from capture', () => {
    const merged = {};
    const settings = { 'stats-cache.json': 'cache' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({});
  });

  it('normalizes node paths when normalizeNodePath=true', () => {
    const merged = {};
    const settings = { launcher: '/usr/bin/node' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: true });
    expect(subset).toEqual({ launcher: 'node' });
  });

  it('leaves absolute node paths intact when normalizeNodePath=false', () => {
    const merged = {};
    const settings = { launcher: '/usr/bin/node' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({ launcher: '/usr/bin/node' });
  });

  it('captures non-excluded ahead keys alongside excluded ones', () => {
    const merged = { safe: 1 };
    const settings = { safe: 1, newKey: 'value', '.credentials.json': 'secret' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({ newKey: 'value' });
  });
});

// ---------------------------------------------------------------------------
// CAPTURE_EXCLUDED_KEYS parity with ALWAYS_NEVER_SYNC
// ---------------------------------------------------------------------------

describe('CAPTURE_EXCLUDED_KEYS', () => {
  it('is a superset of or equal to ALWAYS_NEVER_SYNC members', () => {
    for (const key of ALWAYS_NEVER_SYNC) {
      expect(CAPTURE_EXCLUDED_KEYS.has(key)).toBe(true);
    }
  });

  it('contains all five expected sensitive keys', () => {
    expect(CAPTURE_EXCLUDED_KEYS.has('.claude.json')).toBe(true);
    expect(CAPTURE_EXCLUDED_KEYS.has('.credentials.json')).toBe(true);
    expect(CAPTURE_EXCLUDED_KEYS.has('settings.local.json')).toBe(true);
    expect(CAPTURE_EXCLUDED_KEYS.has('history.jsonl')).toBe(true);
    expect(CAPTURE_EXCLUDED_KEYS.has('stats-cache.json')).toBe(true);
  });
});
