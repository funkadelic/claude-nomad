import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { assertSafeLogical } from './config.sharedDirs.guard.ts';
import { stripCollidingDstSymlinks } from './extras-sync.core.ts';
import { assertSafeLocalRoot } from './extras-sync.guards.ts';
import { claudeHome, repoHome, HOST, type PathMap } from './config.ts';
import { type ManifestDiff } from './push-manifest.ts';
import { die, item, log } from './utils.ts';
import { backupBeforeWrite, backupRepoWrite } from './utils.fs.ts';
import { encodePath, readPathMap } from './utils.json.ts';

/**
 * Suffix for the sibling staging directory used by `atomicMirror`. Stray dirs
 * with this suffix are leftovers from a copy interrupted before its final
 * rename; the next mirror of the same `dst` removes them, and the push readdir
 * loop skips them so they never count as projects.
 */
const TMP_SUFFIX = '.nomad-tmp';

/**
 * Atomic mirror copy: fully populate a sibling temp dir, then swap it into
 * place with a single `renameSync`. The temp dir is a sibling of `dst` (same
 * parent, so same filesystem) which keeps the rename atomic with no EXDEV
 * cross-device fallback.
 *
 * Replaces the previous rm-then-copy: that wiped `dst` and then ran the long
 * `cpSync` into the empty dir, so an interrupt (Ctrl-C during a large copy,
 * crash, ENOSPC) left `dst` empty or half-written. Here an interrupt leaves
 * the live `dst` untouched and only a stray `<dst>.nomad-tmp` behind.
 *
 * `force:true` is preserved for parity with the prior call options though the
 * temp dir is always fresh. The leading `rmSync(tmp)` clears any leftover from
 * a previously interrupted run before copying.
 */
function atomicMirror(src: string, dst: string, options: Parameters<typeof cpSync>[2]): void {
  const tmp = `${dst}${TMP_SUFFIX}`;
  rmSync(tmp, { recursive: true, force: true });
  cpSync(src, tmp, options);
  rmSync(dst, { recursive: true, force: true });
  renameSync(tmp, dst);
}

/**
 * Pull-only retain-merge overlay for a session dir. Unlike the push-side
 * mirror copy (which mirror-replaces `dst`, evicting local-only entries via
 * `atomicMirror`'s `rmSync(dst)`), this ADDS and OVERWRITES repo-tracked files
 * while NEVER
 * deleting a local-only entry: session transcripts, sibling `subagents/` dirs,
 * and `memory/` files that were never pushed survive the pull. It is the
 * `copyExtrasFilteredPreserving` (Phase 49) precedent MINUS the prune pass
 * (retention means never delete local-only), so there is no `rmSync(dst)` and
 * no `prunePreservingDenied` call.
 *
 * `stripCollidingDstSymlinks(src, dst, () => false)` runs BEFORE the copy so a
 * benignly-named dst symlink colliding with a repo `src` entry is removed rather
 * than written THROUGH to an external target (`~/.ssh`, `~/.bashrc`); the
 * `() => false` excludes nothing (sessions have no deny-set). `verbatimSymlinks:
 * true` is load-bearing so relative symlink targets are not rewritten across
 * hosts (Pitfall 1, nodejs/node issue 41693). Pull-only: `remapPush` keeps the
 * exact-mirror `copyDirJsonlOnly` path unchanged.
 *
 * @param src - Repo-side `shared/projects/<logical>/` dir to overlay from.
 * @param dst - Host-side `~/.claude/projects/<encoded>/` dir; local-only
 *   entries survive unchanged after the overlay.
 */
export function overlaySessionDir(src: string, dst: string): void {
  stripCollidingDstSymlinks(src, dst, () => false);
  cpSync(src, dst, { recursive: true, force: true, verbatimSymlinks: true });
}

/**
 * Per-file atomic copy. Creates the destination parent directory, copies `src`
 * to a sibling temp file (`<dst>.tmp.<pid>`), then renames over `dst`. The
 * rename is atomic on the same filesystem (no EXDEV), so an interrupt leaves
 * either the old file or the new file intact, never a partial write. Unchanged
 * siblings are untouched, keeping their inode and mtime for git's stat-cache.
 *
 * @param src - Absolute source file path.
 * @param dst - Absolute destination file path.
 */
export function copyFileAtomic(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp.${process.pid}`;
  cpSync(src, tmp, { force: true, preserveTimestamps: true });
  renameSync(tmp, dst);
}

/**
 * Return `true` when `sel` contains any changed or deleted files whose
 * absolute source path starts with `localDir + sep`. Used to skip a project
 * dir that has no delta entries, avoiding a spurious `backupRepoWrite` call
 * for fully unchanged projects.
 */
function hasDeltaForDir(sel: ManifestDiff, localDir: string): boolean {
  const prefix = `${localDir}${sep}`;
  for (const p of sel.changed) if (p.startsWith(prefix)) return true;
  for (const p of sel.deleted) if (p.startsWith(prefix)) return true;
  return false;
}

/**
 * Return `true` when a selective push has a `selection` that contains no
 * changed or deleted files for `localDir`, meaning the dir can be skipped.
 * Extracted to keep `remapPush` under the cognitive-complexity gate.
 */
function skipForSelection(sel: ManifestDiff | undefined, localDir: string): boolean {
  return sel !== undefined && !hasDeltaForDir(sel, localDir);
}

/**
 * Apply a manifest delta to a single project dir pair. Copies each changed
 * file into `repoDst` via `copyFileAtomic`; removes repo-side copies of
 * deleted source files. Skips files outside `localDir`. Unchanged files are
 * never opened, so their destination inode and mtime are preserved.
 *
 * @param sel - Manifest diff from `diffManifest`.
 * @param localDir - Absolute path of `~/.claude/projects/<encoded>/`.
 * @param repoDst - Absolute path of `shared/projects/<logical>/`.
 */
function applySelective(sel: ManifestDiff, localDir: string, repoDst: string): void {
  const prefix = `${localDir}${sep}`;
  for (const src of sel.changed) {
    if (!src.startsWith(prefix)) continue;
    copyFileAtomic(src, join(repoDst, relative(localDir, src)));
  }
  for (const src of sel.deleted) {
    if (!src.startsWith(prefix)) continue;
    const dst = join(repoDst, relative(localDir, src));
    if (existsSync(dst)) rmSync(dst);
  }
}

/**
 * Push-side mirror copy: an `atomicMirror` with a depth-0 extension filter
 * restricting to *.jsonl files only. Subdirectory contents (subagents,
 * memory, tool-results, etc.) copy recursively with no further filtering.
 * Stray .bak / .tmp / .swp / editor backups at the source root are skipped
 * and produce one dim, indented `skip <rel>: extension not in allowlist`
 * list line each. The filter must allow the source root explicitly (Pitfall 1:
 * cpSync invokes the filter on src === src first, and a false return
 * there would abort the whole copy). Used by remapPush only; remapPull
 * uses `overlaySessionDir` (retain-merge) because the repo side is already
 * curated by the push gate and local-only entries must survive. Uses the same
 * atomic temp-then-rename swap as the other push-side copies;
 * the filter keys off `relative(src, ...)` so it is unaffected by the staging
 * destination.
 */
export function copyDirJsonlOnly(src: string, dst: string): void {
  atomicMirror(src, dst, {
    recursive: true,
    force: true,
    filter: (srcPath) => {
      const rel = relative(src, srcPath);
      if (rel === '') return true;
      if (rel.split(sep).length > 1) return true;
      if (statSync(srcPath).isDirectory()) return true;
      if (srcPath.endsWith('.jsonl')) return true;
      item(`skip ${rel}: extension not in allowlist`);
      return false;
    },
  });
}

/**
 * Event emitted by `remapPull` when `onPreview` is provided under dryRun.
 * `overwrite` is a per-project would-overwrite; `note` is a one-off status
 * message (e.g. the degenerate early return when there is nothing to remap).
 */
export type RemapPullPreviewEvent =
  { kind: 'overwrite'; dst: string; src: string } | { kind: 'note'; text: string };

/**
 * Deliver a dry-run preview event to `onPreview` when present (the glyph-free
 * tree path), else fall back to the `ℹ︎`-prefixed `log(fallback)` line for
 * direct callers. Keeping this branch in one helper keeps `remapPull` under
 * the cognitive-complexity gate.
 *
 * @param onPreview Optional structured sink supplied by `computePreview`.
 * @param event Structured event delivered to `onPreview`.
 * @param fallback Plain message logged when `onPreview` is absent.
 */
function emitPreview(
  onPreview: ((e: RemapPullPreviewEvent) => void) | undefined,
  event: RemapPullPreviewEvent,
  fallback: string,
): void {
  if (onPreview) onPreview(event);
  else log(fallback);
}

/**
 * Pull: copy from repo's logical project names into local path-encoded dirs.
 *
 * Returns `{ unmapped, pulled, wouldPull }`. `unmapped` counts path-map entries
 * skipped for this host (`'TBD'` placeholder or no entry for `HOST`); `pulled`
 * holds logical names copied (wet), `wouldPull` those that would copy under
 * `dryRun`. The arrays let cmdPull render a grouped tree; the wet path no longer
 * logs per-project `pulled X -> Y` / `skip ...` inline. The dry-run path KEEPS
 * its `would overwrite:` line because `computePreview` renders those as the
 * Projects section of `nomad diff` and the dry-run pull preview.
 *
 * `opts.onPreview`: optional structured-event sink for the dry-run preview.
 * When provided, both the per-project `overwrite` events AND the degenerate
 * early-return `note` (nothing to remap) are delivered as
 * `RemapPullPreviewEvent` objects INSTEAD of the `log(...)` lines, so the diff
 * tree stays glyph-free. When absent, the `log(...)` fallback is used unchanged
 * so direct-call tests continue to pass.
 *
 * @param ts - backup timestamp namespace.
 * @param opts.dryRun - when `true`, collect `wouldPull` and log would-overwrite.
 * @param opts.onPreview - structured event sink used by computePreview.
 */
export function remapPull(
  ts: string,
  opts: { dryRun?: boolean; onPreview?: (e: RemapPullPreviewEvent) => void } = {},
): { unmapped: number; pulled: string[]; wouldPull: string[] } {
  const dryRun = opts.dryRun === true;
  let unmapped = 0;
  const pulled: string[] = [];
  const wouldPull: string[] = [];
  const repo = repoHome();
  const claude = claudeHome();
  const mapPath = join(repo, 'path-map.json');
  const repoProjects = join(repo, 'shared', 'projects');
  if (!existsSync(mapPath) || !existsSync(repoProjects)) {
    const text = 'no path-map or repo projects dir; skipping session remap';
    emitPreview(opts.onPreview, { kind: 'note', text }, text);
    return { unmapped: 0, pulled, wouldPull };
  }

  const map = readPathMap(mapPath);
  const localProjects = join(claude, 'projects');
  if (!dryRun) mkdirSync(localProjects, { recursive: true });

  for (const [logical, hosts] of Object.entries(map.projects)) {
    assertSafeLogical(logical);
    const localPath = hosts[HOST];
    if (!localPath || localPath === 'TBD') {
      unmapped++;
      continue;
    }
    // Guard the host VALUE, not just the logical KEY: encodePath only rewrites
    // separators, so a separator-free '..' or '.' survives and join() escapes
    // the projects dir (a '..' resolves dst to ~/.claude itself, which the
    // overlay would then write into). assertSafeLocalRoot rejects non-absolute and
    // unnormalized values, matching the extras-pull defense.
    assertSafeLocalRoot(localPath, logical);
    const src = join(repoProjects, logical);
    if (!existsSync(src)) continue;
    const dst = join(localProjects, encodePath(localPath));
    if (dryRun) {
      wouldPull.push(logical);
      emitPreview(
        opts.onPreview,
        { kind: 'overwrite', dst, src },
        `would overwrite: ${dst} (from ${src})`,
      );
      continue;
    }
    // Snapshot prior encoded-path-dir state BEFORE the overlay overwrites any
    // repo-tracked file (D-05 defense-in-depth; retain-merge means local-only
    // entries survive, so this backup is a safety net, not the primary guard).
    backupBeforeWrite(dst, ts);
    // Retain-merge overlay (never mirror-replace): local-only transcripts,
    // subagents/ dirs, and memory/ files absent from the repo survive the pull.
    overlaySessionDir(src, dst);
    pulled.push(logical);
  }
  return { unmapped, pulled, wouldPull };
}

/**
 * Build the encoded-key to logical-name reverse map for the current host,
 * failing closed on any `path-map.json` shape that would silently lose session
 * data on push. Both failure modes `die()` (throw `NomadFatal`) before the
 * caller writes anything:
 *
 * - Encoded-path collision: two distinct host paths that `encodePath` maps to
 *   the same key (every `/` becomes `-`), which would clobber each other under
 *   one repo directory.
 * - Duplicate path: two logical names mapping to the same host path, where only
 *   one logical could be pushed and the other's `shared/projects/` copy would
 *   be orphaned.
 *
 * @param map - the parsed `path-map.json`
 * @returns reverse lookup from encoded local dir name to logical project name
 */
function buildReverseMap(map: PathMap): Map<string, string> {
  const reverse = new Map<string, string>();
  const encodedPaths = new Map<string, string>();
  for (const [logical, hosts] of Object.entries(map.projects)) {
    assertSafeLogical(logical);
    const p = hosts[HOST];
    if (!p || p === 'TBD') continue;
    const encoded = encodePath(p);
    const prior = encodedPaths.get(encoded);
    if (prior !== undefined) {
      if (prior !== p) {
        die(
          `encoded-path collision in path-map.json: "${prior}" and "${p}" both encode to` +
            ` "${encoded}" (encodePath replaces every / with -).` +
            ` Edit path-map.json so the two paths do not encode identically.` +
            ` Run nomad doctor for the full list of collisions.`,
        );
      }
      die(
        `duplicate path in path-map.json: logical names "${reverse.get(encoded)}" and "${logical}"` +
          ` both map to "${p}" for ${HOST}, so only one could be pushed and the other's` +
          ` shared/projects/ copy would be orphaned.` +
          ` Edit path-map.json so each host path maps to a single logical name.`,
      );
    }
    encodedPaths.set(encoded, p);
    reverse.set(encoded, logical);
  }
  return reverse;
}

/**
 * Push: copy local path-encoded dirs back to repo under logical names.
 *
 * Returns `{ unmapped: N, collisions: M }` where `unmapped` is the count of
 * `~/.claude/projects/<dir>/` entries that have no path-map reverse-lookup
 * for this host. `collisions` is always `0` on the success path: any
 * `path-map.json` shape that would silently lose data (an encoded-path
 * collision between two distinct host paths, or two logical names mapping to
 * the same host path) makes `buildReverseMap` `die()` (throw `NomadFatal`) to
 * refuse the push before any `shared/projects/` content is written. Detection
 * runs during the reverse-map build, so it fires under `dryRun` too.
 *
 * `opts.dryRun` (default `false`): when `true`, collect `wouldPush` without
 * calling `backupRepoWrite` + `copyDirJsonlOnly`. Collision detection runs
 * identically in both modes.
 *
 * `opts.selection` (optional): a `ManifestDiff` from `diffManifest`. When
 * provided, only files in `selection.changed` are copied and only files in
 * `selection.deleted` are removed from the repo; unchanged files are left
 * untouched so their destination inode and mtime remain valid for git's
 * stat-cache. When absent (cold start or full rescan), the entire project dir
 * is mirrored via `copyDirJsonlOnly`, preserving today's behavior including
 * stale-file cleanup.
 *
 * Returns `pushed` (logical names actually copied, wet mode) and `wouldPush`
 * (logical names under `dryRun`) alongside the counts so cmdPush can render a
 * grouped tree. This function no longer logs per-project `pushed X -> Y` /
 * `skip ... not in path-map` / `would push:` lines inline; the
 * `copyDirJsonlOnly` extension-skip log is a separate file-filter concern and
 * is preserved, as are the degenerate early-return `log(...)` lines.
 *
 * @param ts - backup timestamp namespace.
 * @param opts.dryRun - when `true`, collect `wouldPush` without mutating.
 * @param opts.selection - manifest delta; when absent the full dir is mirrored.
 */
export function remapPush(
  ts: string,
  opts: { dryRun?: boolean; selection?: ManifestDiff } = {},
): { unmapped: number; collisions: number; pushed: string[]; wouldPush: string[] } {
  const dryRun = opts.dryRun === true;
  let unmapped = 0;
  const pushed: string[] = [];
  const wouldPush: string[] = [];
  const repo = repoHome();
  const claude = claudeHome();
  const mapPath = join(repo, 'path-map.json');
  if (!existsSync(mapPath)) {
    log('no path-map.json; skipping session export');
    return { unmapped: 0, collisions: 0, pushed, wouldPush };
  }

  const map = readPathMap(mapPath);
  const localProjects = join(claude, 'projects');
  const repoProjects = join(repo, 'shared', 'projects');

  const reverse = buildReverseMap(map);
  if (!existsSync(localProjects)) return { unmapped, collisions: 0, pushed, wouldPush };
  // Create the repo destination only after collision detection passes and we
  // know there is something to push, so a failing or no-op push is fully
  // side-effect-free (no empty shared/projects/ left behind).
  if (!dryRun) mkdirSync(repoProjects, { recursive: true });

  for (const dir of readdirSync(localProjects)) {
    // Ignore staging dirs left by a copy interrupted before its rename swap;
    // they are not projects and a later remap of the real dir cleans them up.
    if (dir.endsWith(TMP_SUFFIX)) continue;
    const logical = reverse.get(dir);
    if (!logical) {
      unmapped++;
      continue;
    }
    const localDir = join(localProjects, dir);
    const repoDst = join(repoProjects, logical);
    // With a selection, skip logicals that have no changed or deleted files.
    if (skipForSelection(opts.selection, localDir)) continue;
    if (dryRun) {
      wouldPush.push(logical);
      continue;
    }
    // Snapshot repo-side destination before any mutation. Git history exists
    // only AFTER the commit step, so a corrupt local dir would have no rollback
    // path without this. Symmetric with remapPull's backupBeforeWrite.
    backupRepoWrite(repoDst, ts, repo);
    if (opts.selection) {
      applySelective(opts.selection, localDir, repoDst);
    } else {
      copyDirJsonlOnly(localDir, repoDst);
    }
    pushed.push(logical);
  }
  return { unmapped, collisions: 0, pushed, wouldPush };
}
