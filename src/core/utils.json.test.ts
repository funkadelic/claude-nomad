import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deepMerge, encodePath, sortKeysDeep, validatePathMapShape } from './utils.json.ts';

/**
 * JSON/string helper coverage, split off from utils.test.ts to mirror the
 * utils.json.ts source module and keep file sizes under the ~200-line cap.
 * Covers deepMerge merge semantics, encodePath path encoding, and the
 * readPathMap FATAL-verb labelling. SUT symbols load from ./utils.json.ts;
 * the wrapped NomadFatal stays in core ./utils.ts.
 */

describe('deepMerge', () => {
  it('overrides scalar values from source', () => {
    const merged = deepMerge({ model: 'sonnet' }, { model: 'opus' });
    expect(merged.model).toBe('opus');
  });

  it('preserves keys only present in target', () => {
    const merged = deepMerge({ a: 1, b: 2 }, { b: 20 });
    expect(merged).toEqual({ a: 1, b: 20 });
  });

  it('recursively merges nested objects', () => {
    const base = { permissions: { allow: ['Bash'], deny: ['Write'] } } as Record<string, unknown>;
    const override = { permissions: { deny: ['Read'] } };
    const merged = deepMerge(base, override);
    expect(merged).toEqual({ permissions: { allow: ['Bash'], deny: ['Read'] } });
  });

  it('replaces arrays rather than concatenating', () => {
    const merged = deepMerge({ allow: ['a', 'b'] }, { allow: ['c'] });
    expect(merged.allow).toEqual(['c']);
  });

  it('treats null source values as overrides', () => {
    const target: Record<string, unknown> = { model: 'sonnet' };
    const merged = deepMerge(target, { model: null });
    expect(merged.model).toBeNull();
  });

  it('does not pollute Object.prototype via a __proto__ payload', () => {
    // JSON.parse surfaces __proto__ as an own enumerable property (the vector a
    // poisoned settings.base.json would use), unlike an object literal.
    const poisoned = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    const base: Record<string, unknown> = { model: 'sonnet' };
    deepMerge(base, poisoned);
    const probe: Record<string, unknown> = {};
    expect(probe.polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('does not copy through a literal __proto__ key', () => {
    const poisoned = JSON.parse('{"__proto__": {"x": 1}, "model": "opus"}') as Record<
      string,
      unknown
    >;
    const base: Record<string, unknown> = { model: 'sonnet' };
    const merged = deepMerge(base, poisoned);
    expect(Object.keys(merged)).toEqual(['model']);
    expect(merged.model).toBe('opus');
  });

  it('does not copy through constructor or prototype keys', () => {
    const poisoned = JSON.parse(
      '{"constructor": {"bad": 1}, "prototype": {"bad": 2}, "a": 1}',
    ) as Record<string, unknown>;
    const base: Record<string, unknown> = {};
    const merged = deepMerge(base, poisoned);
    expect(Object.keys(merged)).toEqual(['a']);
  });
});

describe('sortKeysDeep', () => {
  it('sorts plain object keys lexicographically', () => {
    expect(Object.keys(sortKeysDeep({ b: 1, a: 2 }) as object)).toEqual(['a', 'b']);
  });

  it('sorts nested object keys recursively', () => {
    const sorted = sortKeysDeep({ outer: { z: 1, a: 2 } }) as { outer: object };
    expect(Object.keys(sorted.outer)).toEqual(['a', 'z']);
  });

  it('preserves array element order while sorting keys inside elements', () => {
    const input = {
      items: [
        { b: 1, a: 2 },
        { d: 3, c: 4 },
      ],
    };
    const sorted = sortKeysDeep(input) as { items: object[] };
    expect(Object.keys(sorted.items[0])).toEqual(['a', 'b']);
    expect(Object.keys(sorted.items[1])).toEqual(['c', 'd']);
    // Order preserved: first element still has the 'a'/'b' keys.
    expect(sorted.items[0]).toEqual({ a: 2, b: 1 });
  });

  it('returns an array of scalars unchanged in original order', () => {
    expect(sortKeysDeep([3, 1, 2])).toEqual([3, 1, 2]);
  });

  it('passes scalars and null through as-is', () => {
    expect(sortKeysDeep('s')).toBe('s');
    expect(sortKeysDeep(7)).toBe(7);
    expect(sortKeysDeep(null)).toBeNull();
  });

  it('stringifies value-equal objects identically regardless of input key order', () => {
    const a = sortKeysDeep({ model: 'opus', hooks: {}, statusLine: 1 });
    const b = sortKeysDeep({ statusLine: 1, hooks: {}, model: 'opus' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('encodePath', () => {
  it('encodes macOS absolute path', () => {
    expect(encodePath('/Users/norm/code/ha-acwd')).toBe('-Users-norm-code-ha-acwd');
  });

  it('encodes Linux absolute path', () => {
    expect(encodePath('/home/norm/code/ha-acwd')).toBe('-home-norm-code-ha-acwd');
  });

  it('produces different keys for same logical project on different hosts', () => {
    expect(encodePath('/Users/norm/code/foo')).not.toBe(encodePath('/home/norm/code/foo'));
  });

  it('collapses every non-alphanumeric char (dots, underscores, spaces), not just slashes', () => {
    // Diverges from the old slash-only encoder, which left `.`/`_`/space intact
    // and so never matched the directory Claude Code actually writes.
    expect(encodePath('/U/a.b_c d')).toBe('-U-a-b-c-d');
  });

  it('preserves dashes (they map to themselves under the alphanumeric rule)', () => {
    expect(encodePath('/a-b')).toBe('-a-b');
  });

  it('encodes a Windows drive-letter + backslash path', () => {
    // The CLI runs the same `[^a-zA-Z0-9] -> '-'` rule, so `:` and `\` both
    // become dashes. The old slash-only encoder left this string unchanged.
    expect(encodePath('C:\\Users\\norm\\foo')).toBe('C--Users-norm-foo');
  });

  it('truncates over-200-char encodings and appends a base-36 hash of the original path', () => {
    const longPath = '/Users/norm/' + 'segment/'.repeat(30) + 'end';
    const result = encodePath(longPath);
    // 200-char prefix + '-' separator + 5-char base-36 hash = 206.
    expect(result).toHaveLength(206);
    expect(result.slice(0, 200)).toBe(longPath.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200));
    expect(result[200]).toBe('-');
    // Pin the exact suffix so the hash algorithm (twe: h*31 + c | 0) cannot drift.
    expect(result.slice(201)).toBe('dwj2i');
  });

  it('produces a deterministic, input-sensitive truncation suffix', () => {
    const longPath = '/Users/norm/' + 'segment/'.repeat(30) + 'end';
    const twin = longPath.slice(0, -1) + 'X';
    expect(encodePath(longPath)).toBe(encodePath(longPath));
    expect(encodePath(longPath).slice(201)).not.toBe(encodePath(twin).slice(201));
  });

  it('normalizes a negative rolling hash via Math.abs before base-36 encoding', () => {
    // This fixture's twe() hash is negative (-723934086). Pinning its suffix
    // guards the `Math.abs(int32)` step: a refactor to unsigned/signed base-36
    // formatting would change this exact value while leaving positive-hash
    // fixtures untouched.
    const longPath = '/Users/norm/' + 'segment/'.repeat(30) + 'end0';
    expect(encodePath(longPath).slice(201)).toBe('bz0f46');
  });
});

describe('readPathMap error labels', () => {
  // The wrapped FATAL message conditions its verb ("parse" vs "read") on the
  // underlying error so ops can distinguish malformed JSON from IO/permission
  // failures without scraping the wrapped message. Callers gate on
  // `existsSync(mapPath)` in the happy path, but TOCTOU races and permission
  // changes mid-run still surface here.
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'nomad-readpathmap-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('uses the "parse" verb for malformed JSON', async () => {
    const mapPath = join(testDir, 'path-map.json');
    writeFileSync(mapPath, '{ not json');

    const { readPathMap } = await import('./utils.json.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      readPathMap(mapPath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as Error).message).toMatch(/could not parse path-map\.json/);
  });

  it('uses the "read" verb for IO failures (missing file)', async () => {
    const missing = join(testDir, 'no-such-file.json');

    const { readPathMap } = await import('./utils.json.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      readPathMap(missing);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as Error).message).toMatch(/could not read path-map\.json/);
    expect((caught as Error).message).not.toMatch(/could not parse/);
  });

  it('throws a NomadFatal schema error for valid JSON with an invalid shape', async () => {
    const mapPath = join(testDir, 'path-map.json');
    // Parses fine, but `projects` is an array, not an object.
    writeFileSync(mapPath, '{"projects": []}');

    const { readPathMap } = await import('./utils.json.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      readPathMap(mapPath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as Error).message).toMatch(/invalid schema: "projects" must be an object/);
  });

  it('returns the parsed map for valid JSON with a valid shape', async () => {
    const mapPath = join(testDir, 'path-map.json');
    writeFileSync(mapPath, '{"projects": {"proj": {"host-a": "/abs/path"}}}');

    const { readPathMap } = await import('./utils.json.ts');
    expect(readPathMap(mapPath)).toEqual({ projects: { proj: { 'host-a': '/abs/path' } } });
  });
});

describe('validatePathMapShape', () => {
  it('returns null for a valid shape', () => {
    expect(validatePathMapShape({ projects: { p: { 'host-a': '/x' } } })).toBeNull();
    // Empty projects is valid (the doctor safe-default and a fresh scaffold).
    expect(validatePathMapShape({ projects: {} })).toBeNull();
  });

  it('rejects a non-object top-level value', () => {
    for (const bad of [null, 'str', 42, []]) {
      expect(validatePathMapShape(bad)).toMatch(/top-level value must be an object/);
    }
  });

  it('rejects a missing or non-object projects field', () => {
    expect(validatePathMapShape({})).toMatch(/"projects" must be an object/);
    expect(validatePathMapShape({ projects: null })).toMatch(/"projects" must be an object/);
    expect(validatePathMapShape({ projects: [] })).toMatch(/"projects" must be an object/);
  });

  it('rejects a project whose hosts value is not an object', () => {
    expect(validatePathMapShape({ projects: { p: 'x' } })).toMatch(
      /project "p" hosts must be an object/,
    );
    expect(validatePathMapShape({ projects: { p: ['x'] } })).toMatch(
      /project "p" hosts must be an object/,
    );
    expect(validatePathMapShape({ projects: { p: null } })).toMatch(
      /project "p" hosts must be an object/,
    );
  });

  it('rejects a host whose path value is not a string', () => {
    expect(validatePathMapShape({ projects: { p: { 'host-a': 5 } } })).toMatch(
      /project "p" host "host-a" path must be a string/,
    );
  });
});
