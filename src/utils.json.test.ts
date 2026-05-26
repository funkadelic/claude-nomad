import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deepMerge, encodePath } from './utils.json.ts';

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
});
