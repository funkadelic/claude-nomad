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
 * One walk of the configured shared names: the files it recorded, plus every
 * path it DECLINED to walk.
 *
 * The declined list exists because the two consumers of this walk have opposite
 * failure polarity. For the baseline builder, skipping a path it could not read
 * merely under-records, and an under-recorded baseline authorizes nothing. For
 * the deletion planner the same walk supplies the set of files this host
 * currently has, so a path that was skipped rather than genuinely absent reads
 * as a file the user deleted, and that authorizes removing the repo copy.
 * Reporting the skips is what lets the planner tell the two apart: an absence
 * with no declined path above it is a real deletion, an absence beneath one is
 * simply unknown.
 *
 * Recorded keys and declined paths share one format, `claudeHome()`-relative
 * and POSIX-separated, so testing whether a key sits beneath a declined path is
 * a plain string comparison.
 */
export type LocalSharedScan = {
  /** Recorded regular files, keyed by relative POSIX path. */
  files: Record<string, LocalFileStat>;
  /** Relative POSIX paths the walk refused to descend into or to record. */
  declined: string[];
};

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
 * Record `abs` into `scan.files` if it is a regular file, recurse if it is a
 * directory, and otherwise decline it.
 *
 * Directories themselves are never recorded: `hashFile` throws on one, and a
 * deleted directory is fully described by its files disappearing. A genuinely
 * ABSENT entry contributes nothing and is deliberately NOT declined, because
 * that absence is the deletion signal the whole pass exists to act on. A
 * symlink is declined for the reason the mirror skips one: recording a
 * symlinked tree would let a later un-symlinking read as a mass deletion, and
 * declining it stops a tree that has SINCE become a symlink reading as one now.
 *
 * The stat is wrapped because `throwIfNoEntry: false` suppresses ENOENT only;
 * EACCES, EPERM and EIO still throw, and a locked file is the ordinary Windows
 * condition this pass has to survive rather than crash on.
 *
 * Shared by the top-level name loop and the recursive walk so both agree on
 * what counts as a recordable entry.
 */
function addLocalPath(abs: string, claude: string, scan: LocalSharedScan): void {
  const key = baselineKey(claude, abs);
  let st;
  try {
    st = lstatSync(abs, { throwIfNoEntry: false });
  } catch {
    scan.declined.push(key);
    return;
  }
  if (st === undefined) return;
  if (st.isSymbolicLink()) {
    scan.declined.push(key);
    return;
  }
  if (st.isDirectory()) {
    collectSharedFiles(abs, claude, scan);
    return;
  }
  scan.files[key] = { size: st.size, mtime: st.mtimeMs };
}

/**
 * Walk `dir` recursively via {@link addLocalPath}, declining any basename the
 * always-never-sync deny set rejects so a credential or per-host file can
 * neither enter the baseline nor authorize a deletion later.
 *
 * A directory that cannot be listed is declined rather than throwing: an
 * unreadable subtree costs the builder some missing records, and tells the
 * planner not to read that whole subtree's absence as a deletion.
 */
function collectSharedFiles(dir: string, claude: string, scan: LocalSharedScan): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    scan.declined.push(baselineKey(claude, dir));
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry);
    if (isDeniedName(ALWAYS_NEVER_SYNC, entry)) {
      scan.declined.push(baselineKey(claude, abs));
      continue;
    }
    addLocalPath(abs, claude, scan);
  }
}

/**
 * Walk the shared-link files this host currently has materialized, returning
 * both the recorded files and every path the walk declined (see
 * {@link LocalSharedScan} for why the second half matters).
 *
 * Iterates `allSharedLinks(map)` and nothing else, so a name the user never
 * configured is outside the record entirely; raw path-map keys are never walked.
 * A configured name that the deny set rejects is declined outright, which keeps
 * a deletion from being authorized underneath it.
 *
 * That gate is unreachable as written: every name `allSharedLinks` yields is
 * either a `SHARED_LINKS` static (none of which the deny set rejects) or a
 * `sharedDirs` entry that already cleared `validateSharedDirEntry`, whose
 * rejections are a superset of this deny set's. It is kept as defense-in-depth
 * on a security boundary, so a future loosening of that guard cannot silently
 * authorize deletions under a denied name.
 *
 * Exported because the deletion planner consumes this exact walk. The key
 * format is the contract between the record and its reader, and two
 * implementations of it would eventually disagree.
 *
 * @param map - Parsed `path-map.json`, for the configured shared names.
 * @returns The recorded files plus the relative paths the walk declined.
 */
export function enumerateLocalSharedScan(map: PathMap): LocalSharedScan {
  const claude = claudeHome();
  const scan: LocalSharedScan = { files: {}, declined: [] };
  for (const name of allSharedLinks(map)) {
    /* c8 ignore next 4 -- unreachable defense-in-depth; the sharedDirs guard rejects a superset of this deny set (see above) */
    if (isDeniedName(ALWAYS_NEVER_SYNC, name)) {
      scan.declined.push(name);
      continue;
    }
    addLocalPath(join(claude, name), claude, scan);
  }
  return scan;
}

/**
 * The recorded half of {@link enumerateLocalSharedScan}, keyed by
 * `claudeHome()`-relative POSIX path.
 *
 * The baseline builder consumes only this half deliberately: under-recording is
 * safe for a record whose whole job is to prove a file WAS present, so the
 * builder has no use for the declined paths and no branch that could misread
 * them.
 *
 * @param map - Parsed `path-map.json`, for the configured shared names.
 * @returns Map from relative POSIX key to `{size, mtime}` for each local file.
 */
export function enumerateLocalSharedFiles(map: PathMap): Record<string, LocalFileStat> {
  return enumerateLocalSharedScan(map).files;
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
