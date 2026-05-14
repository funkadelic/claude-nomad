import { execSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

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

export function ensureSymlink(linkPath: string, target: string): void {
  if (existsSync(linkPath)) {
    if (lstatSync(linkPath).isSymbolicLink()) return;
    die(`${linkPath} exists and is not a symlink. Move it aside first.`);
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath);
  log(`linked ${linkPath} -> ${target}`);
}
