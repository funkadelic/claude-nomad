import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  type renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as fsModule from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { freshBackupTs, nowTimestamp, renameAtomicRetry, writeJsonAtomic } from './utils.fs.ts';

/**
 * Builds a fake `NodeJS.ErrnoException` with the given errno `code`, used to
 * drive `renameAtomicRetry`'s retryable/non-retryable branches without
 * touching the real filesystem.
 */
function mkErrnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated rename failure`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

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

describe('writeJsonAtomic directory-fsync EPERM handling (mocked node:fs)', () => {
  let originalHome: string | undefined;
  let testHome: string;
  const realPlatform = process.platform;

  /**
   * Mocks node:fs so fsyncSync throws errno `code` for the read-only
   * directory fd only; the temp-file fsync and all other fs calls pass
   * through to the real implementations.
   */
  const mockDirFsyncFailure = (code: string): void => {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      let dirFd = -1;
      return {
        ...actual,
        openSync: vi.fn((...args: Parameters<typeof actual.openSync>) => {
          const fd = actual.openSync(...args);
          if (args[1] === 'r') dirFd = fd;
          return fd;
        }),
        fsyncSync: vi.fn((fd: number) => {
          if (fd === dirFd) {
            const err = new Error(`${code}: fsync failed`) as NodeJS.ErrnoException;
            err.code = code;
            throw err;
          }
          actual.fsyncSync(fd);
        }),
      };
    });
  };

  /** Overrides process.platform for the current test; restored in afterEach. */
  const setPlatform = (value: string): void => {
    Object.defineProperty(process, 'platform', { value });
  };

  beforeEach(() => {
    vi.resetModules();
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-home-'));
    process.env.HOME = testHome;
  });

  afterEach(() => {
    setPlatform(realPlatform);
    vi.doUnmock('node:fs');
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('swallows EPERM from the directory fsync on win32 and completes the write', async () => {
    mockDirFsyncFailure('EPERM');
    setPlatform('win32');
    const mocked = await import('./utils.fs.ts');
    const target = join(testHome, 'settings.json');
    expect(() => mocked.writeJsonAtomic(target, { a: 1 })).not.toThrow();
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ a: 1 });
  });

  it('rethrows a non-EPERM directory-fsync error on win32', async () => {
    mockDirFsyncFailure('EIO');
    setPlatform('win32');
    const mocked = await import('./utils.fs.ts');
    const target = join(testHome, 'settings.json');
    expect(() => mocked.writeJsonAtomic(target, { a: 1 })).toThrow(/EIO/);
  });

  it('rethrows EPERM from the directory fsync on non-Windows platforms', async () => {
    mockDirFsyncFailure('EPERM');
    expect(process.platform).not.toBe('win32');
    const mocked = await import('./utils.fs.ts');
    const target = join(testHome, 'settings.json');
    expect(() => mocked.writeJsonAtomic(target, { a: 1 })).toThrow(/EPERM/);
  });
});

describe('renameAtomicRetry', () => {
  const realPlatform = process.platform;

  /** Overrides process.platform for the current test; restored in afterEach. */
  const setPlatform = (value: string): void => {
    Object.defineProperty(process, 'platform', { value });
  };

  afterEach(() => {
    setPlatform(realPlatform);
  });

  it('retries EPERM twice then succeeds on win32 against an existing destination', () => {
    setPlatform('win32');
    let calls = 0;
    const renameFn: typeof renameSync = () => {
      calls++;
      if (calls < 3) throw mkErrnoError('EPERM');
    };
    expect(() => renameAtomicRetry('tmp', 'dst', renameFn)).not.toThrow();
    expect(calls).toBe(3);
  });

  it('retries EBUSY the same way as EPERM on win32', () => {
    setPlatform('win32');
    let calls = 0;
    const renameFn: typeof renameSync = () => {
      calls++;
      if (calls < 2) throw mkErrnoError('EBUSY');
    };
    expect(() => renameAtomicRetry('tmp', 'dst', renameFn)).not.toThrow();
    expect(calls).toBe(2);
  });

  it('re-throws a non-EPERM/EBUSY code immediately on win32 (single call, no retry)', () => {
    setPlatform('win32');
    let calls = 0;
    const renameFn: typeof renameSync = () => {
      calls++;
      throw mkErrnoError('ENOENT');
    };
    expect(() => renameAtomicRetry('tmp', 'dst', renameFn)).toThrow(/ENOENT/);
    expect(calls).toBe(1);
  });

  it('re-throws after exhausting the bounded attempt cap when EPERM persists on win32', () => {
    setPlatform('win32');
    let calls = 0;
    const renameFn: typeof renameSync = () => {
      calls++;
      throw mkErrnoError('EPERM');
    };
    expect(() => renameAtomicRetry('tmp', 'dst', renameFn)).toThrow(/EPERM/);
    expect(calls).toBe(5);
  });

  it('on non-win32, calls renameFn exactly once on success (no retry)', () => {
    setPlatform('darwin');
    let calls = 0;
    const renameFn: typeof renameSync = () => {
      calls++;
    };
    expect(() => renameAtomicRetry('tmp', 'dst', renameFn)).not.toThrow();
    expect(calls).toBe(1);
  });

  it('on non-win32, re-throws immediately with a single call (no retry, no backoff)', () => {
    setPlatform('darwin');
    let calls = 0;
    const renameFn: typeof renameSync = () => {
      calls++;
      throw mkErrnoError('EPERM');
    };
    expect(() => renameAtomicRetry('tmp', 'dst', renameFn)).toThrow(/EPERM/);
    expect(calls).toBe(1);
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
