/**
 * Per-host baseline of the shared-link files this host actually materialized
 * under `~/.claude/` at its last successful shared-link apply.
 *
 * The baseline exists to answer exactly one question: was this file present on
 * THIS host last time we finished a pull? Only a yes makes a now-absent file a
 * deletion the user performed; a no makes it a file this host has simply never
 * received, which must never be removed from the sync repo. A tracked-at-HEAD
 * check cannot answer that question (both cases look identical in git), which is
 * why the record is host-local rather than derived from the repo.
 *
 * Storage reuses `push-manifest.ts` wholesale (the same `Manifest` shape,
 * tolerant read, and atomic write) rather than growing a second manifest
 * implementation. Two consequences are deliberate and documented at their
 * definitions below: a producer tag in `scannerVersion` guards against reading
 * the push manifest by mistake, and keys are stored relative to `claudeHome()`
 * so a home-path change can never make every recorded file look deleted.
 */

import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import {
  allSharedLinks,
  claudeHome,
  isDeniedName,
  sharedBaselinePath,
  ALWAYS_NEVER_SYNC,
  type PathMap,
} from './config.ts';
import {
  buildManifest,
  hashFile,
  readManifest,
  writeManifest,
  type Manifest,
  type ManifestEntry,
} from './push-manifest.ts';
import { warn } from './utils.ts';

/**
 * Producer tag written into the manifest's `scannerVersion` field, and required
 * on read. The push manifest and this baseline satisfy the SAME structural
 * shape guard (`isManifestShape` checks only that `scannerVersion` and
 * `configHash` are strings, never their values), so without a discriminator a
 * push manifest copied or mis-resolved onto the baseline path would parse
 * cleanly and authorize deletions from a record that describes a different tree
 * entirely. That field's meaning is "which producer wrote these records, and if
 * it changes, distrust them", which is exactly the use here.
 */
export const SHARED_BASELINE_KIND = 'shared-links-baseline/1';

/**
 * Stable filler for the manifest's `configHash` field. This consumer has no
 * config identity to track (`shouldFullRescan` is a push-side concern and is
 * never called on a baseline), but the field is required by the shared shape
 * guard, so a fixed constant keeps the file round-tripping through
 * `readManifest` without implying a comparison nobody makes.
 */
const SHARED_BASELINE_CONFIG_HASH = 'not-applicable';

/** Size and modification time for one enumerated local file. */
export type LocalFileStat = { size: number; mtime: number };

/**
 * Read this host's baseline, or `null` when there is nothing trustworthy to
 * read: no file, an unreadable file, malformed JSON, a foreign shape, or a
 * record written by a different producer (see {@link SHARED_BASELINE_KIND}).
 *
 * `null` is the fail-safe value and means additive-only: the deletion planner
 * returns an empty plan for it, so every failure mode of reading this file
 * resolves to removing nothing. Never throws.
 *
 * @returns The parsed baseline manifest, or `null` when none can be trusted.
 */
export function readSharedBaseline(): Manifest | null {
  const parsed = readManifest(sharedBaselinePath());
  if (parsed === null) return null;
  if (parsed.scannerVersion !== SHARED_BASELINE_KIND) return null;
  return parsed;
}

/**
 * Key one absolute local path for the baseline: relative to `claudeHome()` and
 * POSIX-separated.
 *
 * Relative rather than absolute (the push manifest keys absolutely) because the
 * two have opposite worst cases: a stale absolute key there costs a redundant
 * rescan, while here it would make every recorded path look deleted the moment
 * `HOME` or `CLAUDE_HOME` resolved differently, and the pass would try to empty
 * the shared tree out of the repo. Separators are normalized on write so a key
 * is stable regardless of which path API produced it, which matters on win32
 * where `join` yields backslashes.
 */
function baselineKey(claude: string, abs: string): string {
  return relative(claude, abs).split(sep).join('/');
}

/**
 * Walk `dir` recursively, adding one entry per regular file to `out`.
 * Directories themselves are never recorded: `hashFile` throws on one, and a
 * deleted directory is fully described by its files disappearing.
 *
 * Skips any basename the always-never-sync deny set rejects, so a credential or
 * per-host file can neither enter the baseline nor authorize a deletion later.
 * Skips symlinks, and skips (rather than fails on) any entry whose stat throws,
 * so an unreadable file costs one missing record instead of a thrown pull.
 */
function collectSharedFiles(dir: string, claude: string, out: Record<string, LocalFileStat>): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (isDeniedName(ALWAYS_NEVER_SYNC, entry)) continue;
    const child = join(dir, entry);
    const st = lstatSync(child, { throwIfNoEntry: false });
    if (st === undefined) continue;
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      collectSharedFiles(child, claude, out);
      continue;
    }
    out[baselineKey(claude, child)] = { size: st.size, mtime: st.mtimeMs };
  }
}

/**
 * Enumerate the shared-link files this host currently has materialized, keyed
 * by `claudeHome()`-relative POSIX path.
 *
 * Iterates `allSharedLinks(map)` and nothing else, so a name the user never
 * configured is outside the record entirely; raw path-map keys are never walked.
 * A name absent from `~/.claude/` contributes nothing (there is nothing to
 * record), and a name that is still a live symlink is skipped, matching the
 * mirror: recording a symlinked tree would let a later un-symlinking read as a
 * mass deletion.
 *
 * Exported because the deletion planner consumes this exact function. The key
 * format is the contract between the record and its reader, and two
 * implementations of it would eventually disagree.
 *
 * @param map - Parsed `path-map.json`, for the configured shared names.
 * @returns Map from relative POSIX key to `{size, mtime}` for each local file.
 */
export function enumerateLocalSharedFiles(map: PathMap): Record<string, LocalFileStat> {
  const claude = claudeHome();
  const out: Record<string, LocalFileStat> = {};
  for (const name of allSharedLinks(map)) {
    if (isDeniedName(ALWAYS_NEVER_SYNC, name)) continue;
    const localPath = join(claude, name);
    const st = lstatSync(localPath, { throwIfNoEntry: false });
    if (st === undefined) continue;
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      collectSharedFiles(localPath, claude, out);
      continue;
    }
    out[baselineKey(claude, localPath)] = { size: st.size, mtime: st.mtimeMs };
  }
  return out;
}

/**
 * Build (but do not persist) the baseline manifest for the currently
 * materialized shared files. A file whose hash throws between the walk and the
 * read (it vanished, it became unreadable) is dropped from the record rather
 * than failing the build: under-recording authorizes nothing, which is the safe
 * direction.
 *
 * @param map - Parsed `path-map.json`, for the configured shared names.
 * @returns A manifest tagged with {@link SHARED_BASELINE_KIND}.
 */
export function buildSharedBaseline(map: PathMap): Manifest {
  const claude = claudeHome();
  const files: Record<string, ManifestEntry> = {};
  for (const [key, st] of Object.entries(enumerateLocalSharedFiles(map))) {
    try {
      files[key] = { size: st.size, mtime: st.mtime, hash: hashFile(join(claude, key)) };
    } catch {
      // Dropped deliberately; see the doc comment above.
    }
  }
  return buildManifest(files, SHARED_BASELINE_KIND, SHARED_BASELINE_CONFIG_HASH);
}

/**
 * Record what this host now has, so the next run can tell a deletion apart from
 * a file this host has never received. Called immediately after the shared-link
 * apply succeeds, and only on the wet path.
 *
 * Cannot throw. It runs after the apply has already rewritten the user's config
 * directory, so a throw here would fail a pull that had in fact succeeded. Any
 * failure degrades to a warning and leaves the previous record in place, which
 * under-authorizes rather than over-authorizes: the worst outcome is that a
 * deletion waits for the next run.
 *
 * No-op on darwin and linux, where a shared name is a symlink and a local
 * deletion is already a repo deletion. The platform gate lives here so callers
 * invoke it unconditionally with no branch of their own, matching the
 * `applySharedLinks` convention.
 *
 * @param map - Parsed `path-map.json`, for the configured shared names.
 */
export function writeSharedBaseline(map: PathMap): void {
  if (process.platform !== 'win32') return;
  try {
    writeManifest(sharedBaselinePath(), buildSharedBaseline(map));
  } catch (err) {
    warn(`could not record the shared-config baseline: ${(err as Error).message}`);
  }
}
