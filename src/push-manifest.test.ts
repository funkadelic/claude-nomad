import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildManifest,
  computeConfigHash,
  diffManifest,
  enumerateSourceFiles,
  hashFile,
  isChanged,
  readManifest,
  shouldFullRescan,
  writeManifest,
  type Manifest,
  type ManifestEntry,
} from './push-manifest.ts';

// ---------------------------------------------------------------------------
// Pure delta-detection core
// ---------------------------------------------------------------------------

describe('isChanged', () => {
  it('returns true when prev is undefined (new file, cold start)', () => {
    const hash = vi.fn(() => 'abc');
    expect(isChanged(undefined, { size: 100, mtime: 1000 }, hash)).toBe(true);
  });

  it('returns true when size differs and does NOT call hash()', () => {
    const prev: ManifestEntry = { size: 100, mtime: 1000, hash: 'abc' };
    const hash = vi.fn(() => {
      throw new Error('hash() must not be called on size-change path');
    });
    expect(isChanged(prev, { size: 200, mtime: 1000 }, hash)).toBe(true);
    expect(hash).not.toHaveBeenCalled();
  });

  it('returns false when size and mtime match without calling hash()', () => {
    const prev: ManifestEntry = { size: 100, mtime: 1000, hash: 'abc' };
    const hash = vi.fn(() => {
      throw new Error('hash() must not be called on size+mtime-match path');
    });
    expect(isChanged(prev, { size: 100, mtime: 1000 }, hash)).toBe(false);
    expect(hash).not.toHaveBeenCalled();
  });

  it('returns false when size matches, mtime differs, but hash matches (benign mtime bump)', () => {
    const prev: ManifestEntry = { size: 100, mtime: 1000, hash: 'abc' };
    expect(isChanged(prev, { size: 100, mtime: 2000 }, () => 'abc')).toBe(false);
  });

  it('returns true when size matches, mtime differs, and hash differs (real change)', () => {
    const prev: ManifestEntry = { size: 100, mtime: 1000, hash: 'abc' };
    expect(isChanged(prev, { size: 100, mtime: 2000 }, () => 'xyz')).toBe(true);
  });
});

describe('diffManifest', () => {
  it('adds a key present in current but absent from old.files to changed', () => {
    const old: Manifest = buildManifest({}, 'v1', 'cfg');
    const current = { '/a/b.jsonl': { size: 10, mtime: 100 } };
    const { changed, deleted } = diffManifest(old, current, () => 'nohash');
    expect(changed.has('/a/b.jsonl')).toBe(true);
    expect(deleted).toHaveLength(0);
  });

  it('adds a key present in old.files but absent from current to deleted', () => {
    const old: Manifest = buildManifest(
      { '/a/b.jsonl': { size: 10, mtime: 100, hash: 'abc' } },
      'v1',
      'cfg',
    );
    const { changed, deleted } = diffManifest(old, {}, () => 'nohash');
    expect(deleted).toContain('/a/b.jsonl');
    expect(changed.size).toBe(0);
  });

  it('omits a size+mtime-matching key from changed and deleted, and does NOT call hashFor', () => {
    const old: Manifest = buildManifest(
      { '/a/b.jsonl': { size: 10, mtime: 100, hash: 'abc' } },
      'v1',
      'cfg',
    );
    const current = { '/a/b.jsonl': { size: 10, mtime: 100 } };
    const hashFor = vi.fn(() => {
      throw new Error('hashFor must not be called on size+mtime-match path');
    });
    const { changed, deleted } = diffManifest(old, current, hashFor);
    expect(changed.size).toBe(0);
    expect(deleted).toHaveLength(0);
    expect(hashFor).not.toHaveBeenCalled();
  });

  it('returns every current key in changed and an empty deleted when old is null', () => {
    const current = {
      '/a/b.jsonl': { size: 10, mtime: 100 },
      '/a/c.jsonl': { size: 20, mtime: 200 },
    };
    const { changed, deleted } = diffManifest(null, current, () => 'nohash');
    expect(changed.has('/a/b.jsonl')).toBe(true);
    expect(changed.has('/a/c.jsonl')).toBe(true);
    expect(deleted).toHaveLength(0);
  });

  it('adds a key with changed size to changed', () => {
    const old: Manifest = buildManifest(
      { '/a/b.jsonl': { size: 10, mtime: 100, hash: 'abc' } },
      'v1',
      'cfg',
    );
    const current = { '/a/b.jsonl': { size: 20, mtime: 100 } };
    const { changed } = diffManifest(old, current, () => 'nohash');
    expect(changed.has('/a/b.jsonl')).toBe(true);
  });

  it('adds a key with matching size but differing mtime and hash to changed', () => {
    const old: Manifest = buildManifest(
      { '/a/b.jsonl': { size: 10, mtime: 100, hash: 'abc' } },
      'v1',
      'cfg',
    );
    const current = { '/a/b.jsonl': { size: 10, mtime: 200 } };
    const { changed } = diffManifest(old, current, () => 'xyz');
    expect(changed.has('/a/b.jsonl')).toBe(true);
  });
});

describe('shouldFullRescan', () => {
  const base: Manifest = buildManifest({}, 'v1', 'cfg1');

  it('returns true immediately when forceFlag is true', () => {
    expect(shouldFullRescan(base, 'v1', 'cfg1', true)).toBe(true);
  });

  it('returns true when old is null (cold start)', () => {
    expect(shouldFullRescan(null, 'v1', 'cfg1', false)).toBe(true);
  });

  it('returns true when scanner version changed', () => {
    expect(shouldFullRescan(base, 'v2', 'cfg1', false)).toBe(true);
  });

  it('returns true when config hash changed', () => {
    expect(shouldFullRescan(base, 'v1', 'cfg2', false)).toBe(true);
  });

  it('returns false when all equal and forceFlag is false', () => {
    expect(shouldFullRescan(base, 'v1', 'cfg1', false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Manifest I/O and source enumeration
// ---------------------------------------------------------------------------

describe('enumerateSourceFiles', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'nomad-enum-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('includes depth-0 *.jsonl files', () => {
    writeFileSync(join(testDir, 'session.jsonl'), 'data');
    const files = enumerateSourceFiles(testDir);
    expect(files).toContain(join(testDir, 'session.jsonl'));
  });

  it('excludes depth-0 non-.jsonl files (*.bak, *.tmp)', () => {
    writeFileSync(join(testDir, 'session.bak'), 'backup');
    writeFileSync(join(testDir, 'session.tmp'), 'temp');
    const files = enumerateSourceFiles(testDir);
    expect(files).not.toContain(join(testDir, 'session.bak'));
    expect(files).not.toContain(join(testDir, 'session.tmp'));
  });

  it('includes nested memory/*.md files (regardless of extension)', () => {
    mkdirSync(join(testDir, 'memory'));
    writeFileSync(join(testDir, 'memory', 'notes.md'), '# notes');
    const files = enumerateSourceFiles(testDir);
    expect(files).toContain(join(testDir, 'memory', 'notes.md'));
  });

  it('includes nested subagents/*.jsonl files', () => {
    mkdirSync(join(testDir, 'subagents'));
    writeFileSync(join(testDir, 'subagents', 'agent.jsonl'), '{}');
    const files = enumerateSourceFiles(testDir);
    expect(files).toContain(join(testDir, 'subagents', 'agent.jsonl'));
  });

  it('includes tool-results/*.txt and other nested files', () => {
    mkdirSync(join(testDir, 'tool-results'));
    writeFileSync(join(testDir, 'tool-results', 'output.txt'), 'result');
    const files = enumerateSourceFiles(testDir);
    expect(files).toContain(join(testDir, 'tool-results', 'output.txt'));
  });

  it('returns absolute paths', () => {
    writeFileSync(join(testDir, 'session.jsonl'), 'data');
    const files = enumerateSourceFiles(testDir);
    for (const f of files) {
      expect(f.startsWith('/')).toBe(true);
    }
  });
});

describe('computeConfigHash', () => {
  let testDir: string;
  let originalNomadRepo: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'nomad-cfghash-'));
    originalNomadRepo = process.env.NOMAD_REPO;
    process.env.NOMAD_REPO = testDir;
  });

  afterEach(() => {
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns a stable hex hash for a fixed set of config files', () => {
    writeFileSync(join(testDir, '.gitleaks.toml'), '[extend]\nuseDefault = true\n');
    const h1 = computeConfigHash();
    const h2 = computeConfigHash();
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when .gitleaks.toml content changes', () => {
    writeFileSync(join(testDir, '.gitleaks.toml'), '[extend]\nuseDefault = true\n');
    const h1 = computeConfigHash();
    writeFileSync(join(testDir, '.gitleaks.toml'), '[extend]\nuseDefault = false\n');
    const h2 = computeConfigHash();
    expect(h1).not.toBe(h2);
  });

  it('changes when .gitleaks.overlay.toml content changes', () => {
    writeFileSync(join(testDir, '.gitleaks.toml'), '[extend]\nuseDefault = true\n');
    const h1 = computeConfigHash();
    writeFileSync(join(testDir, '.gitleaks.overlay.toml'), '# overlay\n');
    const h2 = computeConfigHash();
    expect(h1).not.toBe(h2);
  });

  it('changes when .gitleaksignore content changes', () => {
    writeFileSync(join(testDir, '.gitleaks.toml'), '[extend]\nuseDefault = true\n');
    const h1 = computeConfigHash();
    writeFileSync(join(testDir, '.gitleaksignore'), 'some-fingerprint\n');
    const h2 = computeConfigHash();
    expect(h1).not.toBe(h2);
  });

  it('is stable when no config files are present (absent markers are stable)', () => {
    const h1 = computeConfigHash();
    const h2 = computeConfigHash();
    expect(h1).toBe(h2);
  });
});

describe('readManifest and writeManifest', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'nomad-manifest-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns null for a missing file', () => {
    expect(readManifest(join(testDir, 'nonexistent.json'))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const p = join(testDir, 'bad.json');
    writeFileSync(p, 'not json at all {{{');
    expect(readManifest(p)).toBeNull();
  });

  it('returns null for valid JSON with wrong schema shape', () => {
    const p = join(testDir, 'wrong-shape.json');
    writeFileSync(p, JSON.stringify({ schema: 2, files: {} }));
    expect(readManifest(p)).toBeNull();
  });

  it('round-trips a Manifest through write then read', () => {
    const p = join(testDir, 'manifest.json');
    const manifest = buildManifest(
      { '/a/b.jsonl': { size: 10, mtime: 100, hash: 'abc123' } },
      '8.30.1',
      'cfghash',
    );
    writeManifest(p, manifest);
    const result = readManifest(p);
    expect(result).not.toBeNull();
    expect(result?.schema).toBe(1);
    expect(result?.scannerVersion).toBe('8.30.1');
    expect(result?.configHash).toBe('cfghash');
    expect(result?.files['/a/b.jsonl']).toEqual({ size: 10, mtime: 100, hash: 'abc123' });
  });

  it('writeManifest creates parent directory if missing', () => {
    const nested = join(testDir, 'deep', 'dir', 'manifest.json');
    const manifest = buildManifest({}, '8.30.1', 'cfg');
    writeManifest(nested, manifest);
    expect(readManifest(nested)).not.toBeNull();
  });
});

describe('buildManifest', () => {
  it('returns a Manifest with schema 1 and the provided fields', () => {
    const files = { '/a/b.jsonl': { size: 1, mtime: 2, hash: 'h' } };
    const m = buildManifest(files, 'v1', 'cfg1');
    expect(m.schema).toBe(1);
    expect(m.scannerVersion).toBe('v1');
    expect(m.configHash).toBe('cfg1');
    expect(m.files).toBe(files);
  });
});

describe('hashFile', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'nomad-hashfile-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns lowercase hex SHA-256 (64 chars)', () => {
    const p = join(testDir, 'test.txt');
    writeFileSync(p, 'hello world');
    const h = hashFile(p);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when file content changes', () => {
    const p = join(testDir, 'test.txt');
    writeFileSync(p, 'content A');
    const h1 = hashFile(p);
    writeFileSync(p, 'content B');
    const h2 = hashFile(p);
    expect(h1).not.toBe(h2);
  });
});
