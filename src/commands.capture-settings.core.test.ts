import { describe, expect, it } from 'vitest';

import { KNOWN_SETTINGS_KEYS } from './config.ts';
import {
  buildCaptureSubset,
  CAPTURE_EXCLUDED_KEYS,
  classifySettingsDrift,
  normalizeNodePathsDeep,
  partitionByCaptureExclusion,
} from './commands.capture-settings.core.ts';

/**
 * Behavior tests for the pure direction-aware settings drift core.
 *
 * Covers:
 * - classifySettingsDrift: behind/ahead/changed buckets and sort order.
 * - buildCaptureSubset: ahead-only promotion, secret exclusion, node-path normalization.
 * - normalizeNodePathsDeep: absolute-path matching, bare-string pass-through, recursion.
 * - CAPTURE_EXCLUDED_KEYS covers the credential- and secret-bearing settings keys.
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

  it('leaves a relative bin/node command unchanged (absolute paths only)', () => {
    expect(normalizeNodePathsDeep('./bin/node')).toBe('./bin/node');
    expect(normalizeNodePathsDeep('bin/node')).toBe('bin/node');
  });

  it('matches a root-level /bin/node absolute path', () => {
    expect(normalizeNodePathsDeep('/bin/node')).toBe('node');
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

  it('excludes apiKeyHelper even when locally-only (secret exclusion)', () => {
    const merged = { a: 1 };
    const settings = { a: 1, apiKeyHelper: '/home/me/bin/get-key.sh' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).not.toHaveProperty('apiKeyHelper');
    expect(subset).toEqual({});
  });

  it('excludes a secret-bearing env block from capture (the core leak vector)', () => {
    const merged = {};
    const settings = { env: { ANTHROPIC_API_KEY: 'sk-secret', AWS_SECRET_ACCESS_KEY: 'abc' } };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({});
  });

  it('excludes awsCredentialExport from capture', () => {
    const merged = {};
    const settings = { awsCredentialExport: '/home/me/bin/aws-creds.sh' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({});
  });

  it('excludes awsAuthRefresh from capture', () => {
    const merged = {};
    const settings = { awsAuthRefresh: 'aws sso login' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({});
  });

  it('excludes otelHeadersHelper from capture', () => {
    const merged = {};
    const settings = { otelHeadersHelper: '/home/me/bin/otel-headers.sh' };
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
    const settings = { safe: 1, newKey: 'value', apiKeyHelper: '/home/me/bin/get-key.sh' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({ newKey: 'value' });
  });
});

// ---------------------------------------------------------------------------
// CAPTURE_EXCLUDED_KEYS covers credential- and secret-bearing settings keys
// ---------------------------------------------------------------------------

describe('CAPTURE_EXCLUDED_KEYS', () => {
  it('contains the credential- and secret-bearing settings keys', () => {
    expect(CAPTURE_EXCLUDED_KEYS.has('apiKeyHelper')).toBe(true);
    expect(CAPTURE_EXCLUDED_KEYS.has('awsAuthRefresh')).toBe(true);
    expect(CAPTURE_EXCLUDED_KEYS.has('awsCredentialExport')).toBe(true);
    expect(CAPTURE_EXCLUDED_KEYS.has('otelHeadersHelper')).toBe(true);
    expect(CAPTURE_EXCLUDED_KEYS.has('env')).toBe(true);
  });

  it('holds settings.json key names, not ALWAYS_NEVER_SYNC file names', () => {
    // The guard operates on top-level settings keys; file names would never
    // appear there, so excluding them would protect nothing.
    expect(CAPTURE_EXCLUDED_KEYS.has('.credentials.json')).toBe(false);
    expect(CAPTURE_EXCLUDED_KEYS.has('settings.local.json')).toBe(false);
  });

  it('does not over-exclude a benign shared key', () => {
    expect(CAPTURE_EXCLUDED_KEYS.has('model')).toBe(false);
  });

  it('every excluded key is a known settings.json schema key (schema-coupling guard)', () => {
    // If a future settings-schema sync renames one of these keys, the exclusion
    // would silently go stale; this pins the coupling so the rename is caught.
    const known = new Set(KNOWN_SETTINGS_KEYS);
    for (const key of CAPTURE_EXCLUDED_KEYS) {
      expect(known.has(key)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// partitionByCaptureExclusion
// ---------------------------------------------------------------------------

describe('partitionByCaptureExclusion', () => {
  it('splits keys into promotable and excluded, preserving input order', () => {
    const result = partitionByCaptureExclusion(['myKey', 'env', 'other', 'apiKeyHelper']);
    expect(result.promotable).toEqual(['myKey', 'other']);
    expect(result.excluded).toEqual(['env', 'apiKeyHelper']);
  });

  it('returns all keys as promotable when none are excluded', () => {
    expect(partitionByCaptureExclusion(['a', 'b'])).toEqual({
      promotable: ['a', 'b'],
      excluded: [],
    });
  });

  it('returns all keys as excluded when every key is a credential key', () => {
    expect(partitionByCaptureExclusion(['env', 'apiKeyHelper'])).toEqual({
      promotable: [],
      excluded: ['env', 'apiKeyHelper'],
    });
  });

  it('returns empty partitions for an empty input', () => {
    expect(partitionByCaptureExclusion([])).toEqual({ promotable: [], excluded: [] });
  });
});
