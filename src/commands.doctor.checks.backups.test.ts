import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { warnGlyph } from './color.ts';
import { section } from './commands.doctor.format.ts';
import { reportBackupsCheck } from './commands.doctor.checks.backups.ts';

/**
 * Behavior tests for the `nomad doctor` backups WARN row. The reporter is
 * driven against a hermetic temp backup root (passed as the overridable second
 * argument) so no real `~/.cache` is read. Covers the count-WARN, size-WARN,
 * silent-when-healthy, never-sets-exitCode, and absent-root branches.
 */

let testRoot: string;
let savedExitCode: typeof process.exitCode;

/**
 * Create a `<ts>`-named backup directory under `testRoot`.
 *
 * @param name - The `<ts>` directory name to create.
 */
function makeBackupDir(name: string): void {
  mkdirSync(join(testRoot, name), { recursive: true });
}

/**
 * Create a `<ts>` backup dir holding a single sparse file of `sizeBytes`,
 * written via `ftruncate` so the apparent size is large without consuming the
 * bytes on disk (keeps the size-threshold test fast).
 *
 * @param name - The `<ts>` directory name to create.
 * @param sizeBytes - Apparent size of the sparse file to place inside it.
 */
function makeSizedBackup(name: string, sizeBytes: number): void {
  const dir = join(testRoot, name);
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, 'snapshot.bin'), 'w');
  ftruncateSync(fd, sizeBytes);
  closeSync(fd);
}

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'nomad-doctor-backups-'));
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = savedExitCode;
  rmSync(testRoot, { recursive: true, force: true });
});

describe('reportBackupsCheck', () => {
  it('emits a warn row when the dir count exceeds the threshold', () => {
    for (let i = 0; i < 21; i++) {
      makeBackupDir(`20260101-0000${String(i).padStart(2, '0')}`);
    }
    const s = section('Version Checks');
    reportBackupsCheck(s, testRoot);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(warnGlyph);
    expect(s.items[0]).toContain('21 dirs');
    expect(s.items[0]).toContain('nomad clean --backups');
  });

  it('emits a warn row on the size branch when total size exceeds the threshold', () => {
    // Three dirs (well under the count threshold) but one holds a >200 MB
    // sparse file, so only the size branch can fire the row.
    makeBackupDir('20260101-000001');
    makeBackupDir('20260101-000002');
    makeSizedBackup('20260101-000003', 250 * 1024 * 1024);
    // An empty nested subdir is walked (recursively) and contributes 0.
    mkdirSync(join(testRoot, '20260101-000003', 'nested'), { recursive: true });
    const s = section('Version Checks');
    reportBackupsCheck(s, testRoot);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(warnGlyph);
    expect(s.items[0]).toContain('3 dirs');
    expect(s.items[0]).toContain('nomad clean --backups');
  });

  it('sums files in nested subdirs (directory backups are not undercounted)', () => {
    // The big file sits one level DOWN inside the backup dir, as a directory
    // backup (e.g. agents/) would. A flat one-level walk would miss it and the
    // size row would never fire; the recursive walk must still trip it.
    makeBackupDir('20260101-000001');
    const nested = join(testRoot, '20260101-000001', 'agents');
    mkdirSync(nested, { recursive: true });
    const fd = openSync(join(nested, 'big.bin'), 'w');
    ftruncateSync(fd, 250 * 1024 * 1024);
    closeSync(fd);
    const s = section('Version Checks');
    reportBackupsCheck(s, testRoot);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(warnGlyph);
    expect(s.items[0]).toContain('nomad clean --backups');
  });

  it('skips symlinks in the size walk (no follow, no throw)', () => {
    // A symlink inside a backup dir must be skipped (lstat, never followed), so
    // a link to a huge file does not inflate the figure or loop.
    makeBackupDir('20260101-000001');
    const huge = join(testRoot, 'huge-target.bin');
    const fd = openSync(huge, 'w');
    ftruncateSync(fd, 500 * 1024 * 1024);
    closeSync(fd);
    symlinkSync(huge, join(testRoot, '20260101-000001', 'link.bin'));
    const s = section('Version Checks');
    expect(() => reportBackupsCheck(s, testRoot)).not.toThrow();
    // One small dir, only a symlink inside it: under both thresholds, no row.
    expect(s.items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('is silent when under both the count and size thresholds', () => {
    makeBackupDir('20260101-000001');
    makeSizedBackup('20260101-000002', 1024 * 1024); // 1 MB, ignores non-ts siblings below
    mkdirSync(join(testRoot, 'not-a-backup'), { recursive: true });
    writeFileSync(join(testRoot, 'stray.txt'), 'x');
    const s = section('Version Checks');
    reportBackupsCheck(s, testRoot);
    expect(s.items).toHaveLength(0);
  });

  it('never sets process.exitCode (warn is informational only)', () => {
    for (let i = 0; i < 21; i++) {
      makeBackupDir(`20260101-0000${String(i).padStart(2, '0')}`);
    }
    const s = section('Version Checks');
    reportBackupsCheck(s, testRoot);
    expect(process.exitCode).toBeUndefined();
  });

  it('no-ops with no row and no throw when the backup root is absent', () => {
    const s = section('Version Checks');
    const missing = join(testRoot, 'does-not-exist');
    expect(() => reportBackupsCheck(s, missing)).not.toThrow();
    expect(s.items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('degrades to no row and no throw when the backup root is unreadable', () => {
    // existsSync passes but readdirSync throws (root is a file, not a dir):
    // the tolerant reader must keep the read-only doctor from crashing.
    const s = section('Version Checks');
    const fileRoot = join(testRoot, 'backup-is-a-file');
    writeFileSync(fileRoot, 'x');
    expect(() => reportBackupsCheck(s, fileRoot)).not.toThrow();
    expect(s.items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });
});
