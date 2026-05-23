import { execFileSync } from 'node:child_process';
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
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { dim, failGlyph, green, infoGlyph, okGlyph, red, warnGlyph, yellow } from './color.ts';
import { CLAUDE_HOME, HOME } from './config.ts';

const LOCK_PATH = join(HOME, '.cache', 'claude-nomad', 'nomad.lock');

/** Opaque handle for an acquired lockfile. Pass to `releaseLock` in a `finally`. */
export type LockHandle = { fd: number };

/**
 * Print an informational line prefixed with the dim `ℹ︎` glyph (U+2139+VS15)
 * to stdout. Matches the doctor-style left-gutter glyph format so the whole
 * CLI shares one visual vocabulary instead of the prior `[nomad]` text prefix
 * coexisting with doctor's status glyphs.
 */
export const log = (msg: string): void => console.log(`${dim(infoGlyph)} ${msg}`);

/**
 * Print a success line prefixed with the green `✓` glyph to stdout. Use for
 * positive terminators (e.g., `summary: clean`) where a status confirmation is
 * load-bearing.
 */
export const ok = (msg: string): void => console.log(`${green(okGlyph)} ${msg}`);

/**
 * Print a warning line prefixed with the yellow `⚠︎` glyph to stderr. Use for
 * non-fatal conditions the operator should notice (lock contention, partial
 * sync outcomes, schema drift). Routes through `console.error` so both
 * `console.error` spies and `process.stderr.write` spies in tests catch it.
 */
export const warn = (msg: string): void => {
  console.error(`${yellow(warnGlyph)} ${msg}`);
};

/**
 * Print a fatal-error line prefixed with the red `✗` glyph to stderr. Use for
 * NomadFatal-equivalent failures surfaced to the user; the glyph carries the
 * severity so callers do not need a redundant `FATAL:` text token. Routes
 * through `console.error` so both `console.error` spies and
 * `process.stderr.write` spies in tests catch it.
 */
export const fail = (msg: string): void => {
  console.error(`${red(failGlyph)} ${msg}`);
};

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

/**
 * Run `git <args>` in `cwd`, forwarding stderr and converting non-zero exits
 * to `NomadFatal`. Without this wrap, an ExecException would bubble past the
 * cmdPull/cmdPush NomadFatal-only catch blocks and surface as a stack trace;
 * the finally still releases the lock, but the user UX degrades.
 */
export function gitOrFatal(args: readonly string[], context: string, cwd?: string): void {
  try {
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as Error & { stderr?: Buffer };
    if (e.stderr) process.stderr.write(e.stderr);
    throw new NomadFatal(`${context} failed`);
  }
}

/** Read and JSON-parse `path`. Throws `SyntaxError` on malformed content. */
export function readJson<T>(path: string): T {
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return data as T;
}

/**
 * Atomic write: temp + fsync + rename + parent-dir fsync. Survives
 * interrupted pulls. Preserves the destination file's existing mode when it
 * exists, defaults to 0o600 otherwise so credentials in `settings.json` are
 * not widened by the process umask on every regenerate.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const tmp = `${path}.tmp.${process.pid}`;
  const fd = openSync(tmp, 'w', mode);
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
export const encodePath = (absPath: string): string => absPath.replaceAll('/', '-');

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
  const backupRoot = join(HOME, '.cache', 'claude-nomad', 'backup', ts);
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
  const backupRoot = join(HOME, '.cache', 'claude-nomad', 'backup', ts, 'repo');
  const dst = join(backupRoot, rel);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(absPath, dst, { recursive: true, force: false, preserveTimestamps: true });
}

/**
 * Parallel of `backupBeforeWrite` and `backupRepoWrite`, scoped to an
 * explicit `projectRoot` instead of `CLAUDE_HOME` or `REPO_HOME`. Used by
 * `remapExtrasPull` to snapshot host-side extras content (e.g.
 * `<localRoot>/.planning/`) before `copyExtras` clobbers it. The existing
 * helpers cannot serve this case: their `relative(CLAUDE_HOME, absPath)` and
 * `relative(repoHome, absPath)` guards return a `..`-prefixed string for any
 * path outside their anchor and silently no-op, so a pull-side
 * `<localRoot>/.planning/` would never be backed up.
 *
 * Backup root is `extras/`-prefixed inside the same `<ts>` dir so the
 * snapshot is distinguishable from `CLAUDE_HOME` dumps (no prefix) and
 * `repo/` dumps. Layout: `~/.cache/claude-nomad/backup/<ts>/extras/<rel>/`
 * where `<rel>` is `relative(projectRoot, absPath)`.
 */
export function backupExtrasWrite(absPath: string, ts: string, projectRoot: string): void {
  if (!existsSync(absPath)) return;
  const rel = relative(projectRoot, absPath);
  if (rel.startsWith('..') || rel === '') return;
  const backupRoot = join(HOME, '.cache', 'claude-nomad', 'backup', ts, 'extras');
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
    warn(`another nomad ${verb} running, skipping`);
    return null;
  }
  try {
    process.kill(pid, 0);
    warn(`another nomad ${verb} running, skipping`);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      if (unlinkIfSamePid(pidStr)) return retryOnce(verb);
      warn(`another nomad ${verb} running, skipping`);
      return null;
    }
    warn(`another nomad ${verb} running, skipping`);
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
    warn(`another nomad ${verb} running, skipping`);
    return null;
  }
}
