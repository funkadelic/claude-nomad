import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  CRASH_RETENTION_KEEP,
  handleCrash,
  listCrashFiles,
  pruneCrashDir,
  writeCrashReport,
} from './crash-report.write.ts';

describe('listCrashFiles', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'nomad-crash-list-'));
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('returns [] when the directory does not exist', () => {
    expect(listCrashFiles(join(testRoot, 'missing'))).toEqual([]);
  });

  it('returns entries sorted newest-first', () => {
    const dir = join(testRoot, 'crash');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const older = new Date(now - 10_000);
    const newer = new Date(now);
    writeFileSync(join(dir, 'a.txt'), 'a');
    writeFileSync(join(dir, 'b.txt'), 'b');
    utimesSync(join(dir, 'a.txt'), older, older);
    utimesSync(join(dir, 'b.txt'), newer, newer);
    const files = listCrashFiles(dir);
    expect(files.map((f) => f.name)).toEqual(['b.txt', 'a.txt']);
  });
});

describe('pruneCrashDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nomad-crash-prune-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the newest N files and removes the rest (over threshold)', () => {
    for (let i = 0; i < 5; i++) {
      const p = join(dir, `crash-${i}.txt`);
      writeFileSync(p, `${i}`);
      const t = new Date(Date.now() + i * 1000);
      utimesSync(p, t, t);
    }
    pruneCrashDir(dir, 2);
    const remaining = listCrashFiles(dir).map((f) => f.name);
    expect(remaining).toEqual(['crash-4.txt', 'crash-3.txt']);
  });

  it('removes nothing when file count is at or under the keep threshold', () => {
    writeFileSync(join(dir, 'crash-0.txt'), '0');
    writeFileSync(join(dir, 'crash-1.txt'), '1');
    pruneCrashDir(dir, 5);
    expect(listCrashFiles(dir)).toHaveLength(2);
  });

  it('ignores a per-file unlink error and continues pruning the rest', () => {
    // A directory entry among the prune targets makes unlinkSync throw
    // (EISDIR/EPERM depending on platform); the per-file catch must swallow
    // that and still remove the other, unlink-able prune target.
    const staleDirName = 'crash-stale-dir';
    mkdirSync(join(dir, staleDirName));
    writeFileSync(join(dir, 'crash-new.txt'), 'new');
    // keep = 0 forces both entries to be prune targets.
    expect(() => pruneCrashDir(dir, 0)).not.toThrow();
    expect(existsSync(join(dir, 'crash-new.txt'))).toBe(false);
    // The directory could not be unlinked (not a plain file); it remains,
    // proving the per-file error did not abort the rest of the prune loop.
    expect(existsSync(join(dir, staleDirName))).toBe(true);
  });

  it('defaults keep to CRASH_RETENTION_KEEP when omitted', () => {
    for (let i = 0; i < CRASH_RETENTION_KEEP + 3; i++) {
      writeFileSync(join(dir, `crash-${i}.txt`), `${i}`);
    }
    pruneCrashDir(dir);
    expect(listCrashFiles(dir)).toHaveLength(CRASH_RETENTION_KEEP);
  });
});

describe('writeCrashReport', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'nomad-crash-write-')), 'crash');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the crash dir at 0o700 and the file at 0o600', () => {
    const path = writeCrashReport('report text', dir);
    expect(existsSync(path)).toBe(true);

    expect(statSync(dir).mode & 0o777).toBe(0o700);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('names the file crash-<timestamp>-<pid>.txt under dir', () => {
    const path = writeCrashReport('report text', dir);
    expect(path.startsWith(dir)).toBe(true);
    expect(path).toMatch(/crash-\d{8}-\d{6}-\d+\.txt$/);
  });

  it('writes the exact given text', () => {
    const path = writeCrashReport('exact-report-body', dir);
    expect(readFileSync(path, 'utf8')).toBe('exact-report-body');
  });

  it('prunes the dir after writing (count stays bounded)', () => {
    // writeCrashReport's filename is `crash-<second-resolution-timestamp>-
    // <pid>.txt`, so writing in a tight loop within one process would
    // collide on the same name. Pre-populate with distinctly-named stale
    // files instead, then write once, proving the write path prunes.
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < CRASH_RETENTION_KEEP + 5; i++) {
      writeFileSync(join(dir, `stale-${i}.txt`), `${i}`);
    }
    writeCrashReport('new report', dir);
    expect(listCrashFiles(dir)).toHaveLength(CRASH_RETENTION_KEEP);
  });

  it('defaults dir to crashDir() when omitted', () => {
    const testHome = mkdtempSync(join(tmpdir(), 'nomad-crash-write-default-'));
    const originalHome = process.env.HOME;
    process.env.HOME = testHome;
    try {
      const path = writeCrashReport('default-dir-report');
      expect(path.startsWith(join(testHome, '.cache', 'claude-nomad', 'crash'))).toBe(true);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});

describe('handleCrash', () => {
  const baseOpts = {
    version: '1.2.3',
    platform: 'linux',
    issuesUrl: 'https://example.test/issues',
  };
  let failSpy: MockInstance<(...args: unknown[]) => void>;
  let logSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    failSpy = vi.spyOn(console, 'error').mockReturnValue(undefined);
    logSpy = vi.spyOn(console, 'log').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the crash file path and the issues URL on the happy path', () => {
    handleCrash(new Error('boom'), ['nomad', 'push'], {
      ...baseOpts,
      redact: (text) => text,
      write: () => '/fake/crash/path.txt',
      now: () => '2026-07-17T00:00:00.000Z',
    });
    const errCalls = failSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const logCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(errCalls.some((l: string) => l.includes('This looks like a bug'))).toBe(true);
    expect(logCalls.some((l: string) => l.includes('/fake/crash/path.txt'))).toBe(true);
    expect(logCalls.some((l: string) => l.includes(baseOpts.issuesUrl))).toBe(true);
  });

  it('passes the composed report through the redact seam', () => {
    let capturedReport = '';
    handleCrash(new Error('boom'), ['nomad'], {
      ...baseOpts,
      redact: (text) => {
        capturedReport = text;
        return text;
      },
      write: () => '/fake/path.txt',
    });
    expect(capturedReport).toContain('error: Error: boom');
  });

  it('never throws when the redact seam throws, and still emits a fallback line', () => {
    expect(() =>
      handleCrash(new Error('boom'), ['nomad'], {
        ...baseOpts,
        redact: () => {
          throw new Error('redact exploded');
        },
        write: () => '/fake/path.txt',
      }),
    ).not.toThrow();
    const errCalls = failSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(errCalls.some((l: string) => l.includes('could not write a crash report'))).toBe(true);
  });

  it('never throws when the write seam throws, and still emits a fallback line', () => {
    expect(() =>
      handleCrash(new Error('boom'), ['nomad'], {
        ...baseOpts,
        redact: (text) => text,
        write: () => {
          throw new Error('write exploded');
        },
      }),
    ).not.toThrow();
    const errCalls = failSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(errCalls.some((l: string) => l.includes('could not write a crash report'))).toBe(true);
  });

  it('returns void and never calls process.exit', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit should not be called by handleCrash');
    });
    expect(() =>
      handleCrash(new Error('boom'), ['nomad'], {
        ...baseOpts,
        redact: (text) => text,
        write: () => '/fake/path.txt',
      }),
    ).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('uses the real redactWithGitleaks/writeCrashReport defaults when opts omit them', () => {
    // Sandbox HOME so the default writeCrashReport() call lands in a
    // throwaway crashDir(), never the real developer machine's cache dir.
    const testHome = mkdtempSync(join(tmpdir(), 'nomad-crash-handle-default-'));
    const originalHome = process.env.HOME;
    process.env.HOME = testHome;
    try {
      expect(() =>
        handleCrash(new Error('smoke'), ['nomad', 'smoke-test'], baseOpts),
      ).not.toThrow();
      const errCalls = failSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(errCalls.some((l: string) => l.includes('This looks like a bug'))).toBe(true);
      const crashDirPath = join(testHome, '.cache', 'claude-nomad', 'crash');
      expect(listCrashFiles(crashDirPath)).toHaveLength(1);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});
