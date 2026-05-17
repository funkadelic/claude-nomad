import { execFileSync, execSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { CLAUDE_HOME } from './config.ts';

const LOCK_PATH = join(process.env.HOME ?? '', '.cache', 'claude-nomad', 'nomad.lock');

/** Opaque handle for an acquired lockfile. Pass to `releaseLock` in a `finally`. */
export type LockHandle = { fd: number };

/** Print a `[nomad]`-prefixed informational line to stdout. */
export const log = (msg: string): void => console.log(`[nomad] ${msg}`);

/**
 * Sentinel error class for fatal nomad failures. Thrown by `die()` and caught
 * by top-level command wrappers (cmdPull, cmdPush, nomad.ts dispatcher) so a
 * `finally` block can release locks before the process exits. Avoids the
 * pre-fix bug where `process.exit()` skipped pending `finally` clauses and
 * leaked the lockfile.
 */
export class NomadFatal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NomadFatal';
  }
}

/**
 * Throw a `NomadFatal` with the given message. Callers should `catch` it in
 * the cmdPull/cmdPush try/finally so the lock is released before exit.
 */
export const die = (msg: string): never => {
  throw new NomadFatal(msg);
};

/**
 * Run a shell command and return its trimmed stdout. Convenience wrapper for
 * one-liners where leading/trailing whitespace is noise. Do not use for git
 * porcelain output (the leading status-space is significant); use
 * `gitStatusPorcelainZ` instead.
 */
export const sh = (cmd: string, cwd?: string): string =>
  execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();

/**
 * Shell-free, untrimmed `git status --porcelain=v1 -z` reader. Untrimmed
 * because porcelain v1 -z records start with a 2-char status plus 1 space,
 * and the first record's leading space is part of the format (e.g.
 * `" M path\0"` for unstaged-modified). Going through `sh` would strip that
 * space and shift the fixed-offset parse in `parsePorcelainZ`.
 */
export const gitStatusPorcelainZ = (cwd?: string): string =>
  execFileSync('git', ['status', '--porcelain=v1', '-z'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

/** Read and JSON-parse `path`. Throws `SyntaxError` on malformed content. */
export function readJson<T>(path: string): T {
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return data as T;
}

/** Write `data` as pretty-printed JSON (2-space indent, trailing newline). Non-atomic. */
export function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

/** Atomic write: temp + fsync + rename + parent-dir fsync. Survives interrupted pulls. */
export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp.${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, JSON.stringify(data, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  // Fsync the parent directory so the rename itself is durable across a crash;
  // otherwise the file contents are persisted but the directory entry can be
  // lost. Linux/macOS support this on a read-only fd to the dir.
  const dirFd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** Deep merge: source overrides target. Arrays replace, objects merge recursively. */
export function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = out[key];
    const bothObjects =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing);
    out[key] = bothObjects
      ? deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return out as T;
}

/** Claude Code encodes absolute project paths by replacing `/` with `-`. */
export const encodePath = (absPath: string): string => absPath.replace(/\//g, '-');

/** Local-time YYYYMMDD-HHMMSS timestamp; lexicographically sortable. Pure. */
export function nowTimestamp(): string {
  const d = new Date();
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/**
 * Collision-resistant backup timestamp. `nowTimestamp()` is second-resolution,
 * so two pulls in the same wall-clock second would share `ts`, and the
 * second's `backupBeforeWrite` calls (which use `cpSync` with `force:false`)
 * would silently no-op against the existing first snapshot. Append a `-N`
 * suffix until the backup dir is unique.
 */
export function freshBackupTs(backupRoot: string): string {
  const base = nowTimestamp();
  if (!existsSync(join(backupRoot, base))) return base;
  let n = 1;
  while (existsSync(join(backupRoot, `${base}-${n}`))) n++;
  return `${base}-${n}`;
}

/**
 * Create a symlink at `linkPath` pointing to `target`, idempotently. No-op if
 * a symlink already exists at `linkPath`; dies if a non-symlink exists there
 * (caller should pre-scan and back up first; see `applySharedLinks`).
 */
export function ensureSymlink(linkPath: string, target: string): void {
  if (existsSync(linkPath)) {
    if (lstatSync(linkPath).isSymbolicLink()) return;
    die(`${linkPath} exists and is not a symlink. Move it aside first.`);
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath);
  log(`linked ${linkPath} -> ${target}`);
}

/**
 * Snapshot `absPath` into `~/.cache/claude-nomad/backup/<ts>/<rel>` before destructive write.
 * No-op if source missing or outside CLAUDE_HOME. Recursive for directories.
 */
export function backupBeforeWrite(absPath: string, ts: string): void {
  if (!existsSync(absPath)) return;
  const rel = relative(CLAUDE_HOME, absPath);
  if (rel.startsWith('..') || rel === '') return;
  const backupRoot = join(process.env.HOME ?? '', '.cache', 'claude-nomad', 'backup', ts);
  const dst = join(backupRoot, rel);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(absPath, dst, { recursive: true, force: false, preserveTimestamps: true });
}

/**
 * Parallel of `backupBeforeWrite`, but scoped to `REPO_HOME` instead of
 * `CLAUDE_HOME`. Used by `remapPush` to snapshot repo-side encoded-dir
 * state before `copyDir` clobbers it. Backup root is repo-prefixed so the
 * dump is distinguishable from `CLAUDE_HOME` backups in the same `ts` dir.
 */
export function backupRepoWrite(absPath: string, ts: string, repoHome: string): void {
  if (!existsSync(absPath)) return;
  const rel = relative(repoHome, absPath);
  if (rel.startsWith('..') || rel === '') return;
  const backupRoot = join(process.env.HOME ?? '', '.cache', 'claude-nomad', 'backup', ts, 'repo');
  const dst = join(backupRoot, rel);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(absPath, dst, { recursive: true, force: false, preserveTimestamps: true });
}

/**
 * Acquire the exclusive nomad lockfile so two pulls/pushes cannot mutate
 * `~/.claude/` concurrently. Returns the handle on success, or `null` on
 * contention (caller should `process.exit(0)`; skip-on-contention is the
 * intended UX for backgrounded shell-rc invocations). Detects stale locks by
 * probing the recorded pid with `kill(pid, 0)` and recovers via
 * `unlinkIfSamePid` + `retryOnce`. `verb` is `'pull'` or `'push'`; surfaces
 * in the contention-skip message.
 */
export function acquireLock(verb: string): LockHandle | null {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  try {
    const fd = openSync(LOCK_PATH, 'wx');
    writeFileSync(fd, String(process.pid));
    return { fd };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;
    return checkStaleAndRetry(verb);
  }
}

/**
 * Release a previously-acquired lock handle. No-op when `handle` is null
 * (matches `acquireLock`'s contention return). Tolerates the lockfile having
 * already been unlinked. MUST be called from a `finally` so it runs even when
 * the wrapped command throws.
 */
export function releaseLock(handle: LockHandle | null): void {
  if (handle === null) return;
  try {
    closeSync(handle.fd);
  } catch {
    /* already closed; ignore */
  }
  try {
    unlinkSync(LOCK_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Compare-and-delete helper that closes most of the TOCTOU window between
 * reading a stale lock's pid and removing it: another process could
 * legitimately acquire the lock between those steps, and a naive unlink
 * would clobber it. Re-reads the file and only unlinks if the contents
 * still equal `expectedPidStr`. Returns `true` if the lock was unlinked,
 * `false` if the content drifted or the file already vanished. A microsecond
 * window between the re-read and the unlink remains; the residual race is
 * documented as a backlog item rather than fully closed here.
 */
function unlinkIfSamePid(expectedPidStr: string): boolean {
  let current: string;
  try {
    current = readFileSync(LOCK_PATH, 'utf8').trim();
  } catch {
    return false;
  }
  if (current !== expectedPidStr) return false;
  try {
    unlinkSync(LOCK_PATH);
    return true;
  } catch {
    return false;
  }
}

/**
 * EEXIST recovery path for `acquireLock`. Reads the lockfile pid, probes
 * liveness with `kill(pid, 0)`, and tries one retry only when the pid is
 * dead AND the compare-and-delete in `unlinkIfSamePid` confirms the file
 * has not been replaced under us. Returns `null` (contention skip) in any
 * other case.
 */
function checkStaleAndRetry(verb: string): LockHandle | null {
  let pidStr: string;
  try {
    pidStr = readFileSync(LOCK_PATH, 'utf8').trim();
  } catch {
    pidStr = '';
  }
  const pid = Number.parseInt(pidStr, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    if (unlinkIfSamePid(pidStr)) return retryOnce(verb);
    process.stderr.write(`[nomad] another nomad ${verb} running, skipping\n`);
    return null;
  }
  try {
    process.kill(pid, 0);
    process.stderr.write(`[nomad] another nomad ${verb} running, skipping\n`);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      if (unlinkIfSamePid(pidStr)) return retryOnce(verb);
      process.stderr.write(`[nomad] another nomad ${verb} running, skipping\n`);
      return null;
    }
    process.stderr.write(`[nomad] another nomad ${verb} running, skipping\n`);
    return null;
  }
}

/**
 * Single retry of `openSync(..., 'wx')` after `unlinkIfSamePid` cleared a
 * confirmed-stale lock. Bounded to one attempt to avoid spin loops if the
 * lock is being rapidly recreated by another live process.
 */
function retryOnce(verb: string): LockHandle | null {
  try {
    const fd = openSync(LOCK_PATH, 'wx');
    writeFileSync(fd, String(process.pid));
    return { fd };
  } catch {
    process.stderr.write(`[nomad] another nomad ${verb} running, skipping\n`);
    return null;
  }
}
