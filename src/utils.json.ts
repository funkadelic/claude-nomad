import { readFileSync } from 'node:fs';

import { type PathMap } from './config.ts';
import { NomadFatal } from './utils.ts';

/** Read and JSON-parse `path`. Throws `SyntaxError` on malformed content. */
export function readJson<T>(path: string): T {
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return data as T;
}

/**
 * Read `path-map.json` and wrap failures as `NomadFatal` so callers route the
 * failure through their `try/finally` lock-release path instead of exposing a
 * raw `SyntaxError` (or `ENOENT`/`EACCES`) past `NomadFatal`-only catch
 * blocks. Equivalent to the inline `try { readJson } catch { throw NomadFatal }`
 * pattern in `cmdPush`; use this helper at every other read site so the
 * lock-release contract holds uniformly across the pipeline.
 *
 * Error verb is conditioned on the cause so ops can distinguish parse
 * failures (malformed JSON) from IO failures (permission denied, file
 * removed mid-run) without scraping the wrapped message. Callers gate on
 * `existsSync(mapPath)` first in the happy path, so an `ENOENT` here means
 * a TOCTOU race rather than the expected absent-file case.
 */
export function readPathMap(mapPath: string): PathMap {
  try {
    return readJson<PathMap>(mapPath);
  } catch (err) {
    const verb = err instanceof SyntaxError ? 'parse' : 'read';
    throw new NomadFatal(`could not ${verb} path-map.json: ${(err as Error).message}`);
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
