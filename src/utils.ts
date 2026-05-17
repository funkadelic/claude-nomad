import { execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { CLAUDE_HOME } from './config.ts';

export const log = (msg: string): void => console.log(`[nomad] ${msg}`);

export const die = (msg: string): never => {
  console.error(`[nomad] FATAL: ${msg}`);
  process.exit(1);
  throw new Error(msg);
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
