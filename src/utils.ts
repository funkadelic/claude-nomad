import { execSync } from 'node:child_process';
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

export type LockHandle = { fd: number };

export const log = (msg: string): void => console.log(`[nomad] ${msg}`);

/**
 * Sentinel error class for fatal nomad failures. Thrown by `die()` and caught
 * by top-level command wrappers (cmdPull, cmdPush, nomad.ts dispatcher) so a
 * `finally` block can release locks before the process exits. Avoids the
 * pre-fix bug where `process.exit()` skipped pending `finally` clauses and
 * leaked the lockfile (CR-01).
 */
export class NomadFatal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NomadFatal';
  }
}

export const die = (msg: string): never => {
  throw new NomadFatal(msg);
};

export const sh = (cmd: string, cwd?: string): string =>
  execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();

export function readJson<T>(path: string): T {
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return data as T;
}

export function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

/** Atomic write: temp + fsync + rename. Use for files that must survive interrupted pulls. */
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
 * WR-04: nowTimestamp() is second-resolution. Two pulls in the same wall-clock
 * second would share `ts`, and the second's backupBeforeWrite calls (which use
 * cpSync with force:false) would silently no-op against the existing first
 * snapshot. Append `-N` suffix until the backup dir is unique.
 */
export function freshBackupTs(backupRoot: string): string {
  const base = nowTimestamp();
  if (!existsSync(join(backupRoot, base))) return base;
  let n = 1;
  while (existsSync(join(backupRoot, `${base}-${n}`))) n++;
  return `${base}-${n}`;
}

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
 * WR-03: parallel of backupBeforeWrite, but scoped to REPO_HOME instead of
 * CLAUDE_HOME. Used by remapPush to snapshot repo-side encoded-dir state
 * before copyDir clobbers it. Backup root is repo-prefixed so the dump is
 * distinguishable from CLAUDE_HOME backups in the same ts dir.
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

// Lock-contention returns null (NOT die()); caller exits 0 because skip-on-contention is
// intended UX for backgrounded shell-rc invocations per D-05.
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

function checkStaleAndRetry(verb: string): LockHandle | null {
  let pidStr: string;
  try {
    pidStr = readFileSync(LOCK_PATH, 'utf8').trim();
  } catch {
    pidStr = '';
  }
  const pid = Number.parseInt(pidStr, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      /* race; ignore */
    }
    return retryOnce(verb);
  }
  try {
    process.kill(pid, 0);
    process.stderr.write(`[nomad] another nomad ${verb} running, skipping\n`);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      try {
        unlinkSync(LOCK_PATH);
      } catch {
        /* race; ignore */
      }
      return retryOnce(verb);
    }
    process.stderr.write(`[nomad] another nomad ${verb} running, skipping\n`);
    return null;
  }
}

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
