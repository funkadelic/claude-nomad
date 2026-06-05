import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  cmdClean,
  listBackupDirs,
  parseDuration,
  prunableByAge,
  prunableByCount,
  safeDelete,
} from './commands.clean.ts';

/**
 * Behavior tests for the `nomad clean --backups` prune logic. Drives the pure
 * helpers directly and exercises `cmdClean` against a hermetic temp backup
 * root (passed as the second argument) so no real `~/.cache` is touched.
 * Covers dry-run, age, count, default, safety (symlink + non-ts), and the
 * duration parser, plus the mutual-exclusion and bad-duration exit paths.
 */

const DAY_MS = 86_400_000;

let testRoot: string;
let logSpy: MockInstance<(msg: string) => void>;
let failSpy: MockInstance<(...args: unknown[]) => void>;
let savedExitCode: typeof process.exitCode;

/**
 * Create a `<ts>`-named backup directory under `testRoot` and stamp its mtime.
 *
 * @param name - The `<ts>` directory name to create.
 * @param ageDays - How many days in the past to set the mtime (default 0).
 * @returns Absolute path to the created directory.
 */
function makeBackup(name: string, ageDays = 0): string {
  const full = join(testRoot, name);
  mkdirSync(full, { recursive: true });
  const when = new Date(Date.now() - ageDays * DAY_MS);
  utimesSync(full, when, when);
  return full;
}

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'nomad-clean-'));
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
    /* captured */
  });
  failSpy = vi.spyOn(console, 'error').mockImplementation(() => {
    /* captured */
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = savedExitCode;
  rmSync(testRoot, { recursive: true, force: true });
});

describe('parseDuration', () => {
  it('parses valid 14d / 24h / 30m durations into milliseconds', () => {
    expect(parseDuration('14d')).toBe(14 * 86_400_000);
    expect(parseDuration('24h')).toBe(24 * 3_600_000);
    expect(parseDuration('30m')).toBe(30 * 60_000);
  });

  it('returns null for garbage, missing unit, bad unit, and empty input', () => {
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('14')).toBeNull();
    expect(parseDuration('14x')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });
});

describe('listBackupDirs', () => {
  it('returns [] when the backup root is absent', () => {
    expect(listBackupDirs(join(testRoot, 'does-not-exist'))).toEqual([]);
  });

  it('keeps only <ts>-shaped dirs and sorts newest-first', () => {
    makeBackup('20260516-143501', 5);
    makeBackup('20260516-143502', 1);
    makeBackup('not-a-backup');
    mkdirSync(join(testRoot, 'version-cache'), { recursive: true });
    const dirs = listBackupDirs(testRoot);
    expect(dirs.map((d) => d.name)).toEqual(['20260516-143502', '20260516-143501']);
  });
});

describe('prunableByAge', () => {
  it('selects dirs strictly older than the cutoff and keeps newer ones', () => {
    const now = 100 * DAY_MS;
    const dirs = [
      { name: 'old', mtimeMs: now - 20 * DAY_MS },
      { name: 'fresh', mtimeMs: now - 1 * DAY_MS },
    ];
    expect(prunableByAge(dirs, 14 * DAY_MS, now)).toEqual(['old']);
  });

  it('excludes a dir exactly on the boundary (strict >)', () => {
    const now = 100 * DAY_MS;
    const dirs = [{ name: 'edge', mtimeMs: now - 14 * DAY_MS }];
    expect(prunableByAge(dirs, 14 * DAY_MS, now)).toEqual([]);
  });
});

describe('prunableByCount', () => {
  it('keeps the N newest and returns the rest (newest-first input)', () => {
    const dirs = [
      { name: 'a', mtimeMs: 3 },
      { name: 'b', mtimeMs: 2 },
      { name: 'c', mtimeMs: 1 },
    ];
    expect(prunableByCount(dirs, 1)).toEqual(['b', 'c']);
    expect(prunableByCount(dirs, 3)).toEqual([]);
  });
});

describe('cmdClean dry-run', () => {
  it('lists targets and deletes nothing on disk', () => {
    makeBackup('20260101-000000', 30);
    makeBackup('20260201-000000', 25);
    cmdClean({ dryRun: true, olderThan: '14d' }, testRoot);
    expect(existsSync(join(testRoot, '20260101-000000'))).toBe(true);
    expect(existsSync(join(testRoot, '20260201-000000'))).toBe(true);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('20260101-000000');
    expect(out).toContain('  20260101-000000');
    expect(out).not.toContain('would remove');
    expect(out).toContain('dry-run');
  });
});

describe('cmdClean age', () => {
  it('removes dirs older than the cutoff and keeps newer ones', () => {
    makeBackup('20260101-000000', 30);
    makeBackup('20260530-000000', 1);
    cmdClean({ olderThan: '14d' }, testRoot);
    expect(existsSync(join(testRoot, '20260101-000000'))).toBe(false);
    expect(existsSync(join(testRoot, '20260530-000000'))).toBe(true);
  });
});

describe('cmdClean count', () => {
  it('keeps the N newest dirs and removes the rest', () => {
    makeBackup('20260101-000000', 30);
    makeBackup('20260201-000000', 20);
    makeBackup('20260301-000000', 10);
    cmdClean({ keep: 1 }, testRoot);
    expect(existsSync(join(testRoot, '20260301-000000'))).toBe(true);
    expect(existsSync(join(testRoot, '20260201-000000'))).toBe(false);
    expect(existsSync(join(testRoot, '20260101-000000'))).toBe(false);
  });
});

describe('cmdClean default', () => {
  it('uses the 14d age cutoff when no retention flag is given', () => {
    makeBackup('20260101-000000', 30);
    makeBackup('20260530-000000', 2);
    cmdClean({}, testRoot);
    expect(existsSync(join(testRoot, '20260101-000000'))).toBe(false);
    expect(existsSync(join(testRoot, '20260530-000000'))).toBe(true);
  });

  it('logs a removed summary on a live run', () => {
    cmdClean({}, testRoot);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('removed 0 backup(s)');
  });
});

describe('cmdClean safety', () => {
  it('never deletes a symlink entry even with a <ts>-shaped name', () => {
    const target = mkdtempSync(join(tmpdir(), 'nomad-clean-target-'));
    const link = join(testRoot, '20200101-000000');
    symlinkSync(target, link);
    try {
      cmdClean({ keep: 0 }, testRoot);
      expect(existsSync(link)).toBe(true);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(link, { force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('never deletes a non-<ts>-named entry', () => {
    mkdirSync(join(testRoot, 'keep-me'), { recursive: true });
    makeBackup('20200101-000000', 99);
    cmdClean({ keep: 0 }, testRoot);
    expect(existsSync(join(testRoot, 'keep-me'))).toBe(true);
    expect(existsSync(join(testRoot, '20200101-000000'))).toBe(false);
  });

  it('safeDelete refuses a non-<ts> name and a missing entry', () => {
    mkdirSync(join(testRoot, 'not-ts'), { recursive: true });
    safeDelete(testRoot, 'not-ts');
    safeDelete(testRoot, '20200101-000000');
    expect(existsSync(join(testRoot, 'not-ts'))).toBe(true);
  });
});

describe('cmdClean validation', () => {
  it('rejects --older-than and --keep together and exits 1', () => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as never);
    expect(() => cmdClean({ olderThan: '14d', keep: 3 }, testRoot)).toThrow('exit:1');
    expect(failSpy).toHaveBeenCalled();
  });

  it('rejects an unparseable --older-than value and exits 1', () => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as never);
    expect(() => cmdClean({ olderThan: 'soon' }, testRoot)).toThrow('exit:1');
    expect(failSpy).toHaveBeenCalled();
  });
});
