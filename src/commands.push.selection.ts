import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { claudeHome, HOST, type PathMap } from './config.ts';
import {
  buildManifest,
  diffManifest,
  enumerateSourceFiles,
  hashFile,
  type Manifest,
  type ManifestDiff,
  type ManifestEntry,
  shouldFullRescan,
} from './push-manifest.ts';
import { encodePath, readPathMap } from './utils.json.ts';

/**
 * Enumerate all source files across every project in the path-map that has a
 * local directory for this host. Returns a map from absolute source path to
 * current `{size, mtime}` metadata, matching the predicate used by
 * `copyDirJsonlOnly`. An absent or inaccessible project directory is silently
 * skipped.
 *
 * @param map - Parsed path-map, or `null` when `path-map.json` is absent.
 * @returns Map from absolute path to `{size, mtime}`.
 */
function buildCurrentMap(map: PathMap | null): Record<string, { size: number; mtime: number }> {
  const current: Record<string, { size: number; mtime: number }> = {};
  if (map === null) return current;
  const claude = claudeHome();
  for (const [, hostMap] of Object.entries(map.projects)) {
    const localPath = hostMap[HOST];
    if (!localPath) continue;
    // Session transcripts live at ~/.claude/projects/<encodePath(localPath)>/,
    // not at localPath itself. Mirror the same join that remapPush uses.
    const localDir = join(claude, 'projects', encodePath(localPath));
    if (!existsSync(localDir)) continue;
    for (const f of enumerateSourceFiles(localDir)) {
      const st = statSync(f);
      current[f] = { size: st.size, mtime: st.mtimeMs };
    }
  }
  return current;
}

/**
 * Compute the manifest-driven selection for the current push. Enumerates all
 * source files reachable from the path-map, determines whether a full rescan
 * is needed (cold start, scanner version change, config change, or
 * `--full-scan`), and returns the selection (changed and deleted file sets)
 * plus the new manifest ready to persist after a successful push.
 *
 * Changed files are hashed via a shared cache so the hash thunk called inside
 * `diffManifest` and the entry written into the manifest are computed at most
 * once per file. Unchanged files reuse the prior entry hash.
 *
 * @param map - Parsed path-map, or `null` when `path-map.json` is absent.
 * @param old - Previous manifest, or `null` on cold start.
 * @param scannerVersion - Current scanner version from `probeGitleaks()`.
 * @param configHash - Current config identity from `computeConfigHash()`.
 * @param fullScan - `true` when `--full-scan` was passed.
 * @returns `{ selection, newManifest }` ready for remapPush and writeManifest.
 */
export function computePushSelection(
  map: PathMap | null,
  old: Manifest | null,
  scannerVersion: string,
  configHash: string,
  fullScan: boolean,
): { selection: ManifestDiff | undefined; newManifest: Manifest } {
  const current = buildCurrentMap(map);
  const fullRescan = shouldFullRescan(old, scannerVersion, configHash, fullScan);
  const hashCache = new Map<string, string>();
  const cachedHash = (p: string): string => {
    const hit = hashCache.get(p);
    if (hit !== undefined) return hit;
    const h = hashFile(p);
    hashCache.set(p, h);
    return h;
  };
  // `delta` drives manifest hashing for both paths: on a full rescan every file
  // is (re)hashed, on an incremental push only the changed set is.
  const delta: ManifestDiff = fullRescan
    ? { changed: new Set(Object.keys(current)), deleted: [] }
    : diffManifest(old, current, cachedHash);
  const files: Record<string, ManifestEntry> = {};
  for (const [key, meta] of Object.entries(current)) {
    const hash = delta.changed.has(key) ? cachedHash(key) : old!.files[key].hash;
    files[key] = { size: meta.size, mtime: meta.mtime, hash };
  }
  // A full rescan returns NO selection so remapPush and the dry-run preview fall
  // back to the full-directory mirror, which also prunes repo-side files no
  // longer in the source. A populated full-rescan selection (deleted: []) would
  // skip that cleanup and leave stale transcripts behind.
  return {
    selection: fullRescan ? undefined : delta,
    newManifest: buildManifest(files, scannerVersion, configHash),
  };
}

/**
 * Load the path-map and compute the push selection in one step. Tries to read
 * `path-map.json` at `mapPath`; an absent file yields `map = null` and an
 * undefined selection (cold start triggers a full rescan). A malformed JSON file
 * throws `NomadFatal` (caught by `cmdPush`'s try/finally so the lock releases).
 *
 * Extracted from `cmdPush` so the map-load ternary does not push `cmdPush`
 * over the cognitive-complexity-15 gate.
 *
 * @param mapPath - Absolute path to `path-map.json`.
 * @param old - Previous manifest, or `null` on cold start.
 * @param scannerVersion - Current scanner version from `probeGitleaks()`.
 * @param configHash - Current config identity from `computeConfigHash()`.
 * @param fullScan - `true` when `--full-scan` was passed.
 * @returns `{ map, selection, newManifest }` ready for remapPush and writeManifest.
 */
export function loadSelectionForPush(
  mapPath: string,
  old: Manifest | null,
  scannerVersion: string,
  configHash: string,
  fullScan: boolean,
): { map: PathMap | null; selection: ManifestDiff | undefined; newManifest: Manifest } {
  const map: PathMap | null = existsSync(mapPath) ? readPathMap(mapPath) : null;
  const { selection, newManifest } = computePushSelection(
    map,
    old,
    scannerVersion,
    configHash,
    fullScan,
  );
  return { map, selection, newManifest };
}
