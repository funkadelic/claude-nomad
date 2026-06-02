import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { warnGlyph, yellow } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { BACKUP_BASE } from './config.ts';

/**
 * Shape of a `<ts>` backup directory name as produced by `freshBackupTs`:
 * `YYYYMMDD-HHMMSS` with an optional `-N` collision suffix. Only entries
 * matching this shape are counted and sized, so unrelated cache siblings never
 * leak into the row.
 */
const TS_SHAPE = /^\d{8}-\d{6}(-\d+)?$/;

/**
 * Tolerantly list a directory's entries, degrading to `[]` on any error so an
 * unreadable backup root or `<ts>` subdir never throws out of the read-only
 * doctor run (which `cmdDoctor` would not catch).
 *
 * @param dir - Absolute directory path to enumerate.
 * @returns The entry names, or `[]` on error.
 */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Count threshold above which the backups WARN row fires (dir count). */
const DOCTOR_BACKUP_COUNT_WARN = 20;

/** Size threshold (MB) above which the backups WARN row fires (total size). */
const DOCTOR_BACKUP_SIZE_WARN_MB = 200;

/** Bytes-per-megabyte divisor used to render the size figure. */
const BYTES_PER_MB = 1024 * 1024;

/**
 * Recursively sum the on-disk size (in bytes) of every regular file under a
 * backup `<ts>` directory. Backups of directories (e.g. `agents/`, `skills/`)
 * are copied in with their subtrees, so a flat one-level walk would undercount
 * them to near zero; the recursion reflects the real footprint. Uses `lstat`
 * and never descends symlinks, so the walk cannot loop, and unreadable entries
 * are skipped rather than thrown on (doctor is read-only and tolerant).
 *
 * @param dir - Absolute path to a backup directory (or a nested subdir).
 * @returns Total size in bytes of every regular file beneath `dir`.
 */
function dirSizeBytes(dir: string): number {
  let bytes = 0;
  for (const entry of safeReaddir(dir)) {
    const full = join(dir, entry);
    const st = lstatSync(full, { throwIfNoEntry: false });
    /* c8 ignore start */
    // Entry vanished between readdir and lstat (TOCTOU): skip, never throw.
    if (!st) continue;
    /* c8 ignore stop */
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) bytes += dirSizeBytes(full);
    else bytes += st.size;
  }
  return bytes;
}

/**
 * Total size in megabytes of the given `<ts>` backup directories under
 * `backupBase`. Sums each dir's immediate-file bytes via `dirSizeBytes`.
 *
 * @param backupBase - Absolute path to the backup cache root.
 * @param dirs - The `<ts>` directory names to size (already shape-filtered).
 * @returns Combined size of the dirs, in megabytes.
 */
function totalSizeMb(backupBase: string, dirs: string[]): number {
  let bytes = 0;
  for (const name of dirs) bytes += dirSizeBytes(join(backupBase, name));
  return bytes / BYTES_PER_MB;
}

/**
 * Emit one informational WARN row when the host-local backup cache exceeds
 * either the count threshold (20 dirs) or the size threshold (200 MB), pointing
 * the user at `nomad clean --backups`. Silent when healthy, and a no-op when the
 * backup root does not exist (the `existsSync` guard runs before any other fs
 * op). Never mutates the exit status: this is a nudge, not a gate, mirroring
 * `reportOptionalDeps` / `reportVersionCheck`.
 *
 * @param section - The Nomad Version section to append the WARN row to.
 * @param backupBase - Backup root to inspect (overridable for tests; defaults to `BACKUP_BASE`).
 */
export function reportBackupsCheck(section: DoctorSection, backupBase: string = BACKUP_BASE): void {
  if (!existsSync(backupBase)) return;
  const dirs = safeReaddir(backupBase).filter((n) => TS_SHAPE.test(n));
  const count = dirs.length;
  const sizeMb = totalSizeMb(backupBase, dirs);
  if (count > DOCTOR_BACKUP_COUNT_WARN || sizeMb > DOCTOR_BACKUP_SIZE_WARN_MB) {
    addItem(
      section,
      `${yellow(warnGlyph)} backups: ${count} dirs / ${sizeMb.toFixed(1)} MB (run 'nomad clean --backups')`,
    );
  }
}
