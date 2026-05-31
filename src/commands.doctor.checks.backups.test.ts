import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
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
    // A nested subdir inside a backup dir is a non-file entry and must be
    // skipped by the size walk (not summed, not thrown on).
    mkdirSync(join(testRoot, '20260101-000003', 'nested'), { recursive: true });
    const s = section('Version Checks');
    reportBackupsCheck(s, testRoot);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(warnGlyph);
    expect(s.items[0]).toContain('3 dirs');
    expect(s.items[0]).toContain('nomad clean --backups');
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
});
