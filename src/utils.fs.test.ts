import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { freshBackupTs, nowTimestamp, writeJsonAtomic } from './utils.fs.ts';

/**
 * Filesystem-helper coverage, split off from utils.test.ts to mirror the
 * utils.fs.ts source module and keep file sizes under the ~200-line cap.
 * Covers the pure timestamp helpers, the atomic JSON writer, and the
 * idempotent symlink creator. The recursive backup helpers live in the
 * sibling utils.fs.backup.test.ts. SUT symbols load from ./utils.fs.ts; the
 * die() path inside ensureSymlink throws the core NomadFatal from ./utils.ts.
 */

describe('nowTimestamp', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats local time as YYYYMMDD-HHMMSS', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 16, 14, 35, 1));
    expect(nowTimestamp()).toBe('20260516-143501');
  });

  it('zero-pads single-digit month, day, hour, minute, second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 3, 7, 9));
    expect(nowTimestamp()).toBe('20260105-030709');
  });
});

describe('freshBackupTs', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'nomad-freshts-'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 16, 14, 35, 1));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('returns the bare timestamp when no collision exists', () => {
    expect(freshBackupTs(testRoot)).toBe('20260516-143501');
  });

  it('appends -1 when bare timestamp dir already exists (same-second collision)', () => {
    mkdirSync(join(testRoot, '20260516-143501'));
    expect(freshBackupTs(testRoot)).toBe('20260516-143501-1');
  });

  it('skips through -1, -2, -3 to find first free suffix', () => {
    mkdirSync(join(testRoot, '20260516-143501'));
    mkdirSync(join(testRoot, '20260516-143501-1'));
    mkdirSync(join(testRoot, '20260516-143501-2'));
    expect(freshBackupTs(testRoot)).toBe('20260516-143501-3');
  });
});

describe('writeJsonAtomic', () => {
  let originalHome: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-home-'));
    process.env.HOME = testHome;
    mkdirSync(join(testHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('writes JSON with two-space indent and trailing newline (writeJson parity)', () => {
    const target = join(testHome, '.claude', 'settings.json');
    writeJsonAtomic(target, { model: 'sonnet', hooks: {} });
    const content = readFileSync(target, 'utf8');
    expect(content).toBe(JSON.stringify({ model: 'sonnet', hooks: {} }, null, 2) + '\n');
  });

  it('leaves no .tmp.<pid> sibling after successful write', () => {
    const target = join(testHome, '.claude', 'settings.json');
    writeJsonAtomic(target, { a: 1 });
    const leftover = join(testHome, '.claude', `settings.json.tmp.${process.pid}`);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  it('replaces an existing file atomically (final destination has new content)', () => {
    const target = join(testHome, '.claude', 'settings.json');
    writeFileSync(target, '{"old":true}\n');
    writeJsonAtomic(target, { fresh: 1 });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ fresh: 1 });
  });

  it('preserves an existing destination file mode (0o600 stays 0o600)', () => {
    const target = join(testHome, '.claude', 'settings.json');
    writeFileSync(target, '{"a":1}\n');
    chmodSync(target, 0o600);
    writeJsonAtomic(target, { a: 2 });
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('defaults to 0o600 when destination did not exist', () => {
    const target = join(testHome, '.claude', 'settings.json');
    expect(existsSync(target)).toBe(false);
    writeJsonAtomic(target, { fresh: 1 });
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});

describe('ensureSymlink', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'nomad-ensuresymlink-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('dies when the link path exists as a regular file (not a symlink)', async () => {
    const { ensureSymlink } = await import('./utils.fs.ts');
    const { NomadFatal } = await import('./utils.ts');
    const target = join(testDir, 'target.txt');
    const linkPath = join(testDir, 'link');
    writeFileSync(target, 'target-content');
    // Plant a regular file (not symlink) at linkPath. ensureSymlink must
    // refuse to overwrite via die() rather than clobber the file.
    writeFileSync(linkPath, 'pre-existing regular file');
    expect(() => ensureSymlink(linkPath, target)).toThrow(NomadFatal);
    expect(() => ensureSymlink(linkPath, target)).toThrow(/exists and is not a symlink/);
  });

  it('creates the symlink when linkPath does not exist yet', async () => {
    // Happy path: linkPath absent -> symlinkSync called -> link exists pointing
    // at target. Kills the L84 BooleanLiteral mutation (existsSync forced true
    // would call lstatSync on a non-existent path and throw ENOENT instead of
    // creating the symlink).
    const { ensureSymlink } = await import('./utils.fs.ts');
    const target = join(testDir, 'target.txt');
    const linkPath = join(testDir, 'link');
    writeFileSync(target, 'target-content');
    expect(existsSync(linkPath)).toBe(false);
    expect(() => ensureSymlink(linkPath, target)).not.toThrow();
    // The link must now exist and must be a symlink pointing to target.
    expect(existsSync(linkPath)).toBe(true);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });

  it('is a no-op when a symlink already exists at linkPath (idempotent)', async () => {
    // Idempotency path: linkPath exists as a symlink -> isSymbolicLink() returns
    // true -> function returns early without calling symlinkSync again.
    // Kills the L85 ConditionalExpression mutation (isSymbolicLink() forced false
    // would fall through to die(), throwing NomadFatal on a valid symlink).
    const { ensureSymlink } = await import('./utils.fs.ts');
    const target = join(testDir, 'target.txt');
    const linkPath = join(testDir, 'link');
    writeFileSync(target, 'target-content');
    symlinkSync(target, linkPath);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    // Second call must not throw even though the link already exists.
    expect(() => ensureSymlink(linkPath, target)).not.toThrow();
    // The link still exists and is still a symlink.
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });
});
