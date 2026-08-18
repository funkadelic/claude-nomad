import { existsSync, lstatSync, readdirSync, rmSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

import { backupBase as getBackupBase } from './config.ts';
import { EXIT } from './exit-codes.ts';
import { fail, item, log } from './utils.ts';
import { acquireLock, releaseLock } from './utils.lockfile.ts';

/**
 * Shape of a `<ts>` backup directory name as produced by `freshBackupTs`:
 * `YYYYMMDD-HHMMSS` with an optional `-N` collision suffix. The prune logic
 * pins to this so only directories created by the backup machinery are ever
 * considered for deletion: no stray files, no `version-check.json`.
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
 * Projection helper: a backup dir's own name, for mapping descriptor lists
 * down to the name lists every prune path speaks in.
 *
 * @param d - A backup dir descriptor.
 * @returns Its `<ts>` entry name.
 */
function nameOf(d: BackupDir): string {
  return d.name;
}

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
 * Whether a `<ts>` backup dir holds nothing recoverable: no file, no symlink,
 * nothing at all beneath it except more empty directories.
 *
 * A pull creates its backup dir before its first destructive step, so a run
 * that overwrites nothing leaves the dir behind holding zero bytes. Those are
 * pruned whatever their age, since retention exists to protect content and
 * there is none here to protect.
 *
 * Only a directory counts as "not content". Every other entry type does,
 * symlinks included: `readdirSync` with `withFileTypes` classifies from the
 * entry itself rather than its target, so a link is reported as a link and
 * this stops rather than following it out of the cache.
 *
 * An unreadable directory answers `false`. The question is whether the dir is
 * known to be empty, and a failed read answers nothing about its contents, so
 * treating it as empty would make an unreadable snapshot a prune target on the
 * strength of the error alone.
 *
 * @param dir - Absolute path to a `<ts>` dir (or a nested subdir).
 * @returns `true` only when nothing but empty directories lies beneath `dir`.
 */
function holdsNoContent(dir: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) return false;
    if (!holdsNoContent(join(dir, entry.name))) return false;
  }
  return true;
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
 * Delete a single backup dir under `backupBase`, enforcing a triple
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
 * a live run each target passes through the `safeDelete` safety guard and a
 * `removed N backup(s)` summary is logged.
 *
 * A `<ts>` dir holding no content is pruned in every mode, whatever its age
 * and whatever `keep` says, and takes no slot in the retention count; see
 * {@link holdsNoContent}.
 *
 * Runs under the same lock as `pull`/`push`/`sync`, taken after the usage
 * checks so a bad flag still exits 2 without touching it. A pull creates its
 * `<ts>` dir before its first destructive step and only then copies into it,
 * so an unlocked prune could read that dir as empty and remove it in the
 * window before the copy lands, destroying the one snapshot of a file the
 * pull is about to overwrite. Contention exits 0 without pruning, the same
 * skip every other locked command takes, since a delayed cleanup costs
 * nothing.
 *
 * @param opts - Parsed CLI options.
 * @param opts.dryRun - List targets without deleting when `true`.
 * @param opts.olderThan - Age duration string (`14d`, `24h`, `30m`).
 * @param opts.keep - Number of newest snapshots to retain.
 * @param backupBase - Backup root to operate on (overridable for tests; defaults to `BACKUP_BASE`).
 */
export function cmdClean(
  opts: { dryRun?: boolean; olderThan?: string; keep?: number },
  backupBase: string = getBackupBase(),
): void {
  const { dryRun, olderThan, keep } = opts;
  if (olderThan !== undefined && keep !== undefined) {
    fail('--older-than and --keep are mutually exclusive');
    process.exit(EXIT.USAGE);
  }
  let olderThanMs = CLEAN_DEFAULT_OLDER_THAN_MS;
  if (olderThan !== undefined) {
    const parsed = parseDuration(olderThan);
    if (parsed === null) {
      fail(`invalid --older-than duration: ${olderThan} (expected e.g. 14d, 24h, 30m)`);
      process.exit(EXIT.USAGE);
    }
    olderThanMs = parsed;
  }

  // A dry run reads and prints, so it takes no lock: skipping it on contention
  // would print nothing at all, and a caller reading the
  // `dry-run: N backup(s) would be removed` line has no way to tell that
  // silence from a genuine zero.
  if (dryRun) {
    pruneBackups({ dryRun, olderThanMs, keep }, backupBase);
    return;
  }
  const handle = acquireLock('clean');
  if (handle === null) process.exit(EXIT.SUCCESS);
  try {
    pruneBackups({ dryRun, olderThanMs, keep }, backupBase);
  } finally {
    releaseLock(handle);
  }
}

/**
 * The prune itself, split out so `cmdClean` stays a thin validate-lock-release
 * wrapper and this body keeps one level of nesting rather than sitting inside
 * the `try`.
 *
 * @param opts - Validated options: `dryRun`, the resolved `olderThanMs`
 *   cutoff, and `keep`.
 * @param backupBase - Backup root to operate on.
 */
function pruneBackups(
  opts: { dryRun?: boolean; olderThanMs: number; keep?: number },
  backupBase: string,
): void {
  const { dryRun, olderThanMs, keep } = opts;
  const dirs = listBackupDirs(backupBase);
  // Empty dirs are pruned in every mode, and are held out of the retention
  // computation rather than merely added to its result: `--keep 5` is a request
  // for the five newest recoverable snapshots, and counting empty ones toward
  // that would retain five directories holding nothing while deleting the
  // content the flag was meant to keep.
  const empty = new Set(dirs.filter((d) => holdsNoContent(join(backupBase, d.name))).map(nameOf));
  const aged = new Set(
    resolveTargets(
      dirs.filter((d) => !empty.has(d.name)),
      olderThanMs,
      keep,
    ),
  );
  const targets = dirs.filter((d) => empty.has(d.name) || aged.has(d.name)).map(nameOf);

  if (dryRun) {
    for (const name of targets) item(name);
    log(`dry-run: ${targets.length} backup(s) would be removed`);
    return;
  }

  for (const name of targets) safeDelete(backupBase, name);
  log(`removed ${targets.length} backup(s)`);
}
