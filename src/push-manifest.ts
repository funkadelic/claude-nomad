/**
 * Source-side push manifest: change detection, config identity, and manifest
 * persistence for incremental push scanning. Records per-file `{size, mtime,
 * hash}` plus scanner version and config identity to determine which source
 * files changed since the last successful push, avoiding a full re-copy and
 * re-scan on every push.
 *
 * Pure functions (`isChanged`, `diffManifest`, `shouldFullRescan`) use
 * injected `{size, mtime}` and lazy hash thunks so every branch reaches 100%
 * patch coverage without real filesystem or clock dependence (mirrors the
 * `prunableByAge(dirs, olderThanMs, nowMs)` seam in `commands.clean.ts`).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { repoHome } from './config.ts';
import { resolveTomlPath } from './push-gitleaks.config.ts';
import { writeJsonAtomic } from './utils.fs.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-file record written into the manifest after a successful push. */
export type ManifestEntry = { size: number; mtime: number; hash: string };

/**
 * The push manifest persisted to `~/.cache/claude-nomad/push-manifest-<HOST>.json`.
 * `schema` is the literal `1` (no enum, erasableSyntaxOnly). `files` is keyed
 * by absolute source path so detection is source-side and host-local.
 */
export type Manifest = {
  schema: 1;
  scannerVersion: string;
  configHash: string;
  files: Record<string, ManifestEntry>;
};

/**
 * Result of `diffManifest`: the set of source paths that changed or are new
 * (`changed`) and the paths present in the old manifest but absent from the
 * current source tree (`deleted`).
 */
export type ManifestDiff = { changed: Set<string>; deleted: string[] };

// ---------------------------------------------------------------------------
// Pure delta-detection core
// ---------------------------------------------------------------------------

/**
 * Return `true` when a source file should be re-copied and re-scanned.
 * Applies the size + mtime fast path first; hashes only when size matches
 * and mtime moved (tiebreak for false mtime bumps from cpSync / clock skew).
 *
 * The `hash` thunk is NEVER called when `prev.size !== cur.size` or when
 * `prev.size === cur.size && prev.mtime === cur.mtime`; callers rely on this
 * to avoid paying SHA-256 cost on unchanged files.
 *
 * @param prev - Previous manifest entry, or `undefined` for a new file.
 * @param cur - Current stat metadata for the source file.
 * @param hash - Lazy SHA-256 thunk; called only when size matches and mtime moved.
 * @returns `true` when the file should be re-scanned.
 */
export function isChanged(
  prev: ManifestEntry | undefined,
  cur: { size: number; mtime: number },
  hash: () => string,
): boolean {
  if (prev === undefined) return true;
  if (prev.size !== cur.size) return true;
  if (prev.mtime === cur.mtime) return false;
  return prev.hash !== hash();
}

/**
 * Compute the delta between an old manifest and the current source file set.
 * Returns `changed` (new or modified paths) and `deleted` (paths in old but
 * absent from current). When `old` is `null` (cold start) every key in
 * `current` is placed in `changed` with no hashing.
 *
 * `hashFor` is called only for entries where size matches the old record but
 * mtime moved; the cost is zero for a steady-state push with no size changes.
 *
 * @param old - Previous manifest, or `null` on cold start.
 * @param current - Map from absolute source path to current `{size, mtime}`.
 * @param hashFor - SHA-256 callback; called only when size matches and mtime moved.
 * @returns `{ changed: Set<string>, deleted: string[] }`.
 */
export function diffManifest(
  old: Manifest | null,
  current: Record<string, { size: number; mtime: number }>,
  hashFor: (absPath: string) => string,
): ManifestDiff {
  const changed = new Set<string>();
  const deleted: string[] = [];

  if (old === null) {
    for (const key of Object.keys(current)) {
      changed.add(key);
    }
    return { changed, deleted };
  }

  for (const [key, cur] of Object.entries(current)) {
    const prev = old.files[key];
    if (isChanged(prev, cur, () => hashFor(key))) {
      changed.add(key);
    }
  }

  for (const key of Object.keys(old.files)) {
    if (!(key in current)) {
      deleted.push(key);
    }
  }

  return { changed, deleted };
}

/**
 * Return `true` when the manifest requires a full rescan of all source files.
 * Triggers: explicit `forceFlag`, cold start (`old === null`), scanner version
 * change, or config identity change. All three config-change inputs
 * (`.gitleaks.toml`, `.gitleaks.overlay.toml`, `.gitleaksignore`) feed the
 * `configHash` parameter; a change to any of them forces one full rescan.
 *
 * @param old - Previous manifest, or `null` on cold start.
 * @param scannerVersion - Current scanner version string from `probeGitleaks()`.
 * @param configHash - Current config identity from `computeConfigHash()`.
 * @param forceFlag - `true` when `--full-scan` was passed explicitly.
 * @returns `true` when a full rescan is required.
 */
export function shouldFullRescan(
  old: Manifest | null,
  scannerVersion: string,
  configHash: string,
  forceFlag: boolean,
): boolean {
  if (forceFlag) return true;
  if (old === null) return true;
  if (old.scannerVersion !== scannerVersion) return true;
  if (old.configHash !== configHash) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Manifest I/O and source enumeration
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hex digest of a file's raw bytes. Used as the tiebreak
 * hash when a source file's size matches the manifest but its mtime moved.
 *
 * @param absPath - Absolute path to the file to hash.
 * @returns Lowercase hex SHA-256 digest (64 characters).
 */
export function hashFile(absPath: string): string {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

/**
 * Recursively enumerate all regular files under `dir`, appending absolute
 * paths to `results`. Used internally by `enumerateSourceFiles` for subdir
 * traversal. All files under a subdirectory are tracked regardless of extension
 * (mirroring `copyDirJsonlOnly`'s unfiltered subdir copy).
 */
function enumerateDir(dir: string, results: string[]): void {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const st = statSync(fullPath);
    if (st.isDirectory()) {
      enumerateDir(fullPath, results);
    } else {
      results.push(fullPath);
    }
  }
}

/**
 * Enumerate all source files that `copyDirJsonlOnly` would copy for a given
 * project directory, returning their absolute paths. The selection predicate is
 * byte-identical to `copyDirJsonlOnly`'s cpSync filter (see `remap.ts`):
 *   - Depth-0 `*.jsonl` files are included.
 *   - All files under any subdirectory are included regardless of extension
 *     (`subagents/*.jsonl`, `memory/*.md`, `tool-results/*.txt`, etc.).
 *   - Depth-0 non-`.jsonl` files (`.bak`, `.tmp`, editor backups) are excluded.
 *
 * This invariant is the manifest correctness guarantee: every file that would
 * be copied into the repo is tracked, so a secret in a nested `.md` cannot
 * skip the manifest and evade the scan.
 *
 * @param projectDir - Absolute path to a `~/.claude/projects/<encoded>/` dir.
 * @returns Sorted array of absolute source file paths.
 */
export function enumerateSourceFiles(projectDir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(projectDir)) {
    const fullPath = join(projectDir, entry);
    const st = statSync(fullPath);
    if (st.isDirectory()) {
      enumerateDir(fullPath, results);
    } else if (fullPath.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Compute a stable identity string for a file, or a stable "absent" marker
 * when the file does not exist. Used by `computeConfigHash` to feed the hash
 * over all three gitleaks config inputs; an absent file always contributes the
 * same marker so the config hash is stable across calls when no files change.
 */
function fileIdentity(p: string | null): string {
  /* c8 ignore start */
  if (p === null) return 'none::absent';
  /* c8 ignore stop */
  if (!existsSync(p)) return `${p}::absent`;
  return `${p}::${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
}

/**
 * Compute the config identity hash over the three gitleaks config inputs:
 * the active base `.gitleaks.toml` (repo-local or bundled, per `resolveTomlPath`),
 * `REPO_HOME/.gitleaks.overlay.toml`, and `REPO_HOME/.gitleaksignore`. A change
 * to any of these triggers a full rescan on the next push. Absent files contribute
 * a stable "absent" marker so the hash is stable when no files change.
 *
 * @returns Lowercase hex SHA-256 of the concatenated file identities.
 */
export function computeConfigHash(): string {
  const repo = repoHome();
  const parts = [
    fileIdentity(resolveTomlPath(repo)),
    fileIdentity(join(repo, '.gitleaks.overlay.toml')),
    fileIdentity(join(repo, '.gitleaksignore')),
  ];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * Return `true` when `raw` matches the `Manifest` shape. A minimal structural
 * guard: checks `schema === 1`, `scannerVersion` and `configHash` are strings,
 * and `files` is a non-null object. Does not deep-validate `files` entries
 * (a cold-start null return is cheaper than a full walk on a corrupt manifest).
 */
function isManifestShape(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const m = raw as Record<string, unknown>;
  return (
    m.schema === 1 &&
    typeof m.scannerVersion === 'string' &&
    typeof m.configHash === 'string' &&
    m.files !== null &&
    typeof m.files === 'object' &&
    !Array.isArray(m.files)
  );
}

/**
 * Read and parse the manifest at `path`. Returns `null` when the file is
 * missing, contains malformed JSON, or does not match the `Manifest` shape.
 * A `null` return is treated as a cold start (full rescan). Mirrors the
 * tolerant-read pattern of `readGitleaksReport` in `push-gitleaks.scan.ts`.
 *
 * @param path - Absolute path to the manifest JSON file.
 * @returns Parsed `Manifest` or `null` on any read/parse failure.
 */
export function readManifest(path: string): Manifest | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isManifestShape(parsed)) return null;
    return parsed as Manifest;
  } catch {
    return null;
  }
}

/**
 * Atomically persist `manifest` to `path`, creating parent directories as
 * needed. Uses `writeJsonAtomic` (temp + fsync + rename + dir-fsync) so an
 * interrupted write never leaves a half-written manifest. Should be called
 * only after a push fully succeeds; do NOT call on dry-run or push failure.
 *
 * @param path - Absolute path to write the manifest JSON file.
 * @param manifest - The manifest to persist.
 */
export function writeManifest(path: string, manifest: Manifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, manifest);
}

/**
 * Construct a new `Manifest` from the given fields. `schema` is always `1`.
 *
 * @param files - Map from absolute source path to `ManifestEntry`.
 * @param scannerVersion - Scanner version string from `probeGitleaks()`.
 * @param configHash - Config identity string from `computeConfigHash()`.
 * @returns A new `Manifest` ready to pass to `writeManifest`.
 */
export function buildManifest(
  files: Record<string, ManifestEntry>,
  scannerVersion: string,
  configHash: string,
): Manifest {
  return { schema: 1, scannerVersion, configHash, files };
}
