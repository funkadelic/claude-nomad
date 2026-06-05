import { existsSync, lstatSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { BACKUP_BASE } from './config.ts';
import { fail, item, log } from './utils.ts';

/**
 * Shape of a `<ts>` backup directory name as produced by `freshBackupTs`:
 * `YYYYMMDD-HHMMSS` with an optional `-N` collision suffix. The prune logic
 * pins to this so only directories created by the backup machinery are ever
 * considered for deletion (D-05 safety: no stray files, no `version-check.json`).
 */
const TS_SHAPE = /^\d{8}-\d{6}(-\d+)?$/;

/** Duration token grammar accepted by `parseDuration` (e.g. `14d`, `24h`, `30m`). */
const DURATION_RE = /^(\d+)([dhm])$/;

/** Millisecond factor per duration unit letter. */
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };

/** Default age cutoff (14 days in ms) applied when no retention flag is given. */
const CLEAN_DEFAULT_OLDER_THAN_MS = 14 * 24 * 60 * 60 * 1000;

/** A `<ts>` backup directory tagged with its modification time. */
type BackupDir = { name: string; mtimeMs: number };

/**
 * Whether a directory entry name matches the `<ts>` backup shape.
 *
 * @param name - A single path segment (entry name, never a full path).
 * @returns `true` only for names of the form `YYYYMMDD-HHMMSS[-N]`.
 */
function isTsDir(name: string): boolean {
  return TS_SHAPE.test(name);
}

/**
 * Parse a human duration string into milliseconds. Only the small grammar
 * `<digits><d|h|m>` is accepted (`14d`, `24h`, `30m`); anything else (missing
 * unit, unknown unit, empty, non-numeric) returns `null`.
 *
 * @param s - The raw `--older-than` value to parse.
 * @returns The duration in milliseconds, or `null` on any parse failure.
 */
export function parseDuration(s: string): number | null {
  const m = DURATION_RE.exec(s);
  if (!m) return null;
  return Number(m[1]) * UNIT_MS[m[2]];
}

/**
 * Enumerate the `<ts>` backup directories directly under `backupBase`, each
 * tagged with its `mtimeMs`, sorted newest-first. Non-`<ts>` siblings are
 * filtered out. Returns `[]` when the backup root does not exist.
 *
 * @param backupBase - Absolute path to the backup cache root.
 * @returns Backup dir descriptors `{ name, mtimeMs }`, newest first.
 */
export function listBackupDirs(backupBase: string): BackupDir[] {
  if (!existsSync(backupBase)) return [];
  return readdirSync(backupBase)
    .filter(isTsDir)
    .map((name) => ({ name, mtimeMs: statSync(join(backupBase, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Pure age filter: returns the names of dirs strictly older than `olderThanMs`
 * relative to `nowMs`. The strict `>` excludes a dir sitting exactly on the
 * boundary so the result is stable across runs at the cutoff instant.
 *
 * @param dirs - Backup dir descriptors (order irrelevant).
 * @param olderThanMs - Age cutoff in milliseconds.
 * @param nowMs - The reference "now" in epoch ms (injected for deterministic tests).
 * @returns Names of dirs whose age exceeds the cutoff.
 */
export function prunableByAge(dirs: BackupDir[], olderThanMs: number, nowMs: number): string[] {
  return dirs.filter((d) => nowMs - d.mtimeMs > olderThanMs).map((d) => d.name);
}

/**
 * Pure count filter: keeps the `keep` newest dirs and returns the names of the
 * rest. `dirs` MUST already be sorted newest-first (as `listBackupDirs`
 * guarantees).
 *
 * @param dirs - Backup dir descriptors, newest-first.
 * @param keep - Number of newest dirs to retain.
 * @returns Names of the dirs beyond the `keep` newest.
 */
export function prunableByCount(dirs: BackupDir[], keep: number): string[] {
  return dirs.slice(keep).map((d) => d.name);
}

/**
 * Delete a single backup dir under `backupBase`, enforcing the D-05 triple
 * guard. Refuses any name that fails the `<ts>` shape, then `lstatSync`s the
 * entry (NOT `statSync`, which would follow a symlink) and refuses when it is
 * missing, not a directory, or itself a symlink. Only a real `<ts>` directory
 * that resolves to a direct child of `backupBase` is removed.
 *
 * @param backupBase - Absolute path to the backup cache root.
 * @param name - The `<ts>` entry name to delete (a single path segment).
 */
export function safeDelete(backupBase: string, name: string): void {
  if (!isTsDir(name)) return;
  const full = join(backupBase, name);
  const st = lstatSync(full, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return;
  rmSync(full, { recursive: true, force: true });
}

/**
 * Resolve the prune target set from the parsed options. Returns the list of
 * `<ts>` dir names to remove (count path when `keep` is given, otherwise the
 * age path using the parsed-or-default cutoff against `Date.now()`).
 *
 * @param dirs - Backup dir descriptors, newest-first.
 * @param olderThanMs - Parsed `--older-than` cutoff, or the default when absent.
 * @param keep - Parsed `--keep` value, or `undefined` for the age path.
 * @returns Names of the dirs to prune.
 */
function resolveTargets(
  dirs: BackupDir[],
  olderThanMs: number,
  keep: number | undefined,
): string[] {
  if (keep !== undefined) return prunableByCount(dirs, keep);
  return prunableByAge(dirs, olderThanMs, Date.now());
}

/**
 * Prune old `<ts>` snapshot directories under the backup cache root.
 *
 * Retention is mutually exclusive: `olderThan` (age) and `keep` (count) may
 * not both be set, and an unparseable `olderThan` is rejected; either error
 * prints a FATAL line and exits 1. With neither flag the 14-day age default
 * applies. On `dryRun` the target names are listed and nothing is deleted; on
 * a live run each target passes through the `safeDelete` D-05 guard and a
 * `removed N backup(s)` summary is logged.
 *
 * @param opts - Parsed CLI options.
 * @param opts.dryRun - List targets without deleting when `true`.
 * @param opts.olderThan - Age duration string (`14d`, `24h`, `30m`).
 * @param opts.keep - Number of newest snapshots to retain.
 * @param backupBase - Backup root to operate on (overridable for tests; defaults to `BACKUP_BASE`).
 */
export function cmdClean(
  opts: { dryRun?: boolean; olderThan?: string; keep?: number },
  backupBase: string = BACKUP_BASE,
): void {
  const { dryRun, olderThan, keep } = opts;
  if (olderThan !== undefined && keep !== undefined) {
    fail('--older-than and --keep are mutually exclusive');
    process.exit(1);
  }
  let olderThanMs = CLEAN_DEFAULT_OLDER_THAN_MS;
  if (olderThan !== undefined) {
    const parsed = parseDuration(olderThan);
    if (parsed === null) {
      fail(`invalid --older-than duration: ${olderThan} (expected e.g. 14d, 24h, 30m)`);
      process.exit(1);
    }
    olderThanMs = parsed;
  }

  const dirs = listBackupDirs(backupBase);
  const targets = resolveTargets(dirs, olderThanMs, keep);

  if (dryRun) {
    for (const name of targets) item(name);
    log(`dry-run: ${targets.length} backup(s) would be removed`);
    return;
  }

  for (const name of targets) safeDelete(backupBase, name);
  log(`removed ${targets.length} backup(s)`);
}
