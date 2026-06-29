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
  let parsed: unknown;
  try {
    parsed = readJson<unknown>(mapPath);
  } catch (err) {
    const verb = err instanceof SyntaxError ? 'parse' : 'read';
    throw new NomadFatal(`could not ${verb} path-map.json: ${(err as Error).message}`);
  }
  const shapeError = validatePathMapShape(parsed);
  if (shapeError !== null) throw new NomadFatal(shapeError);
  return parsed as PathMap;
}

/**
 * Validate the structural shape of a parsed `path-map.json` value: the top
 * level is an object, `projects` is an object, each project's hosts is an
 * object, and every host value is a string. Returns null when the shape is
 * valid, or a human-readable reason. Centralizes the walk previously duplicated
 * verbatim in `resume.ts`, the doctor path-map check, and the bare cast in
 * `readPathMap`, so the error vocabulary is uniform across the CLI.
 *
 * The optional `extras`/`sharedDirs` fields are not checked here; their
 * consumers (`extras-sync`, `allSharedLinks`) guard those independently.
 *
 * @param raw The JSON-parsed candidate value.
 * @returns null when valid, else a `path-map.json invalid schema: ...` reason.
 */
export function validatePathMapShape(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'path-map.json invalid schema: top-level value must be an object';
  }
  const projects: unknown = (raw as { projects?: unknown }).projects;
  if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) {
    return 'path-map.json invalid schema: "projects" must be an object';
  }
  for (const [name, hosts] of Object.entries(projects as Record<string, unknown>)) {
    if (hosts === null || typeof hosts !== 'object' || Array.isArray(hosts)) {
      return `path-map.json invalid schema: project "${name}" hosts must be an object`;
    }
    for (const [host, value] of Object.entries(hosts as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        return `path-map.json invalid schema: project "${name}" host "${host}" path must be a string`;
      }
    }
  }
  return null;
}

/** Deep merge: source overrides target. Arrays replace, objects merge recursively. */
export function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    // Skip prototype-pollution vectors. Settings JSON is parsed from the
    // untrusted synced repo, and assigning these keys would mutate (or shadow)
    // Object.prototype for the running process and persist into
    // ~/.claude/settings.json on the next pull.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
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

/**
 * Recursively canonicalize a parsed JSON value for stable, order-independent
 * display diffing. Sorts plain-object keys lexicographically so two value-equal
 * objects with different key insertion order stringify identically. Array
 * element order is preserved (arrays are semantic and replace wholesale in
 * `deepMerge`), but each element is recursed into so nested object keys inside
 * array items are also sorted. Scalars and `null` pass through unchanged.
 *
 * Display-only: callers must NOT feed the output to the write path
 * (`regenerateSettings`); it exists purely to canonicalize key order before a
 * preview/diff so a pure key relocation does not render as removed-then-readded.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b, 'en'))) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Max encoded length before Claude Code truncates and appends a hash. Mirrors
 * the CLI's `Db` constant (verified against build 2.1.195). Keep in sync.
 */
const ENCODE_MAX = 200;

/**
 * Java-style 32-bit string hash (`twe` in the CLI): `h = h * 31 + charCode`,
 * forced to int32 on every step via `| 0`. The `| 0` wraparound is
 * load-bearing for byte-fidelity with the CLI; do not "simplify" it away.
 * Used only for the truncation suffix of over-long encoded paths.
 */
const hashPath = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
};

/**
 * Encode an absolute project path to its `~/.claude/projects/<encoded>/`
 * directory name, byte-faithful to Claude Code's `Db` encoder: every
 * non-alphanumeric char becomes `-`, and encodings over `ENCODE_MAX` chars are
 * truncated and suffixed with a base-36 hash of the ORIGINAL path (not the
 * dashed form). This is how the same logical project maps to a different
 * directory key on every host (and the only encoder that matches the CLI on
 * Windows, where paths carry `\` and a drive-letter `:`).
 */
export const encodePath = (absPath: string): string => {
  const enc = absPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (enc.length <= ENCODE_MAX) return enc;
  return `${enc.slice(0, ENCODE_MAX)}-${Math.abs(hashPath(absPath)).toString(36)}`;
};
