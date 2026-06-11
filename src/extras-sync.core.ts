import { cpSync, existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  ALWAYS_NEVER_SYNC,
  CLAUDE_EXTRA_NEVER_SYNC,
  HOST,
  repoHome,
  SUPPORTED_EXTRAS,
  type PathMap,
} from './config.ts';
import { assertSafeLocalRoot, assertSafeLogical } from './extras-sync.guards.ts';
import { log } from './utils.ts';
import { readPathMap } from './utils.json.ts';

/** Parsed `path-map.json` plus its validated `extras` block. */
export type ValidatedExtras = { map: PathMap; extrasMap: Record<string, string[]> };

/** Skip counts: `unmapped` per-project (no host path / `'TBD'`), `skipped` per-dirname (not whitelisted). */
export type ExtrasCounts = { unmapped: number; skipped: number };

/**
 * Load and validate `path-map.json` for an extras op, owning the guard order
 * so the "FATAL before any filesystem mutation" contract holds for every
 * caller. Returns the parsed map plus its `extras` block, or `null` on a clean
 * early-exit (missing `path-map.json`, a missing repo extras dir when
 * `requireRepoExtras`, or an empty/absent `extras` key). THE VALIDATION PASS
 * runs here, up-front over the whole map (`assertSafeLogical` per logical,
 * `assertSafeLocalRoot` per mapped non-`'TBD'` path) so a clean entry ahead of
 * a poisoned one cannot let a `mkdirSync`/`cpSync` land before the FATAL fires.
 *
 * @param opts.requireRepoExtras - Also require `shared/extras/` (pull side).
 * @param opts.missingMsg - `log()` line on the missing-prereq exit (omitted for
 *   the divergence check, which skips silently).
 */
export function loadValidatedExtras(opts: {
  requireRepoExtras?: boolean;
  missingMsg?: string;
}): ValidatedExtras | null {
  const repo = repoHome();
  const mapPath = join(repo, 'path-map.json');
  const repoExtras = join(repo, 'shared', 'extras');
  if (!existsSync(mapPath) || (opts.requireRepoExtras === true && !existsSync(repoExtras))) {
    if (opts.missingMsg !== undefined) log(opts.missingMsg);
    return null;
  }

  const map = readPathMap(mapPath);
  const extrasMap = map.extras ?? {};
  if (Object.keys(extrasMap).length === 0) return null;

  for (const logical of Object.keys(extrasMap)) {
    assertSafeLogical(logical);
    const localRoot = map.projects[logical]?.[HOST];
    if (localRoot && localRoot !== 'TBD') assertSafeLocalRoot(localRoot, logical);
  }
  return { map, extrasMap };
}

/**
 * Yield every surviving `{ logical, localRoot, dirname }` extras target after
 * the per-project and per-dirname skip filters, mutating `counts` as it goes
 * (`unmapped++` for a project with no host path / `'TBD'`, then skip it;
 * `skipped++` for a dirname outside `SUPPORTED_EXTRAS`). Shared by push, pull,
 * and the divergence check so all three walk identical skip/count semantics;
 * the caller builds src/dst from the yielded triple.
 *
 * @param v - validated path-map plus its extras block.
 * @param counts - mutated in place as targets are skipped or yielded. Skips are
 *   counted silently (no per-skip log line); the caller's detail arrays and the
 *   collapsed count row carry that information to the tree renderer.
 */
export function* eachExtrasTarget(
  v: ValidatedExtras,
  counts: ExtrasCounts,
): Generator<{ logical: string; localRoot: string; dirname: string }> {
  const whitelist: readonly string[] = SUPPORTED_EXTRAS;
  for (const [logical, dirnames] of Object.entries(v.extrasMap)) {
    const localRoot = v.map.projects[logical]?.[HOST];
    if (!localRoot || localRoot === 'TBD') {
      counts.unmapped++;
      continue;
    }
    for (const dirname of dirnames) {
      if (!whitelist.includes(dirname)) {
        counts.skipped++;
        continue;
      }
      yield { logical, localRoot, dirname };
    }
  }
}

/**
 * Overlay (additive/overwrite) copy for `.planning`: calls `cpSync` with no
 * preceding `rmSync` and no prune pass, so dst-only files survive by design.
 * This is the pull-side copy for the `.planning` extra; deletion of files
 * removed from the upstream repo is driven separately by the git-diff D set
 * (plan 02), NOT by this function. Contrast with `copyExtras` (true mirror
 * via `rmSync` before copy) and `copyExtrasFilteredPreserving` (prune-but-
 * preserve-deny-set variant). Passes `verbatimSymlinks: true` to keep
 * relative symlink targets unrewritten across hosts (Pitfall 1; nodejs/node
 * issue 41693).
 *
 * @param src - Source directory to copy from (repo side on pull).
 * @param dst - Destination path (host-side project dir); dst-only files
 *   survive unchanged after the overlay.
 */
export function copyExtrasOverlay(src: string, dst: string): void {
  cpSync(src, dst, { recursive: true, force: true, verbatimSymlinks: true });
}

/**
 * Recursive mirror copy: `rmSync` then `cpSync` so dst-only entries are
 * removed (true mirror, not just overwrite). Passes `verbatimSymlinks: true`
 * to keep relative symlink targets unrewritten across hosts (Pitfall 1;
 * nodejs/node issue 41693). Exported so the test file can call it directly;
 * `remapExtrasPush` and `remapExtrasPull` are the primary public API.
 */
export function copyExtras(src: string, dst: string): void {
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true, force: true, verbatimSymlinks: true });
}

/**
 * Denylist of path-segment names to exclude when copying a given extra. The
 * `.claude` extra mirrors `~/.claude/` semantics, so its subdirectory names
 * (`projects`, `shell-snapshots`, `statsig`, `telemetry`, `sessions`, `todos`,
 * ...) are exactly the ephemeral, host-local state that must not sync; it gets
 * `CLAUDE_EXTRA_NEVER_SYNC` (the full `NEVER_SYNC` set plus `projects`).
 * Content-style extras (`.planning`) keep the narrow `ALWAYS_NEVER_SYNC` subset
 * so legitimate names like `todos`/`plans` inside a synced `.planning/` tree are
 * not false-blocked (Pitfall 6). Mirrored by `blockSetFor` in
 * `commands.push.allowlist.ts` so the copy filter and the push gate agree.
 *
 * @param dirname - The extra's whitelisted name (e.g. `.claude`, `.planning`).
 * @returns The set of basenames to skip during the copy.
 */
export function extrasDenySet(dirname: string): Set<string> {
  return dirname === '.claude' ? CLAUDE_EXTRA_NEVER_SYNC : ALWAYS_NEVER_SYNC;
}

/**
 * Filtered mirror copy for the push side: behaves like `copyExtras` but skips
 * any non-root entry whose basename is in `blockSet`. The root `src` entry is
 * always kept (the denylist applies to contents, not the source dir itself), so
 * a source whose own basename collides with a denied name is still mirrored
 * rather than silently producing an empty `dst`. Callers select `blockSet` via
 * `extrasDenySet(dirname)`. The unfiltered `copyExtras` is intentionally left
 * unchanged so callers wanting an exact byte-mirror keep it.
 *
 * Limitation: with `verbatimSymlinks: true` (load-bearing for Pitfall 1), a
 * symlink is copied as a link without dereferencing, so the filter sees the
 * link's own basename, not its target. A benignly-named symlink pointing at a
 * denied file is copied verbatim (its target path, not its content); the push
 * `gitleaks` scan is the backstop for that residual case.
 *
 * Exported so the test file can call it directly and assert filter semantics.
 * `remapExtrasPush` is the primary public entry point.
 *
 * @param src - Source directory to copy from.
 * @param dst - Destination path (wiped then rebuilt, filtered).
 * @param blockSet - Basenames to exclude from the copy (see `extrasDenySet`).
 */
export function copyExtrasFiltered(src: string, dst: string, blockSet: Set<string>): void {
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    filter: (srcEntry) => srcEntry === src || !blockSet.has(basename(srcEntry)),
  });
}

/**
 * Recursively prune dst entries the repo no longer ships, mirroring
 * `copyExtras` deletion semantics at every depth WITHOUT touching host-local
 * deny-set files. At each level: an entry whose basename is in `blockSet` is
 * preserved wholesale (skipped, never recursed into), so nested per-host state
 * like `settings.local.json` or a `projects/` tree survives. A non-deny entry
 * absent from src is removed. When both src and dst hold the same name as
 * directories the prune recurses to clear nested stale content; when the node
 * types differ (dst dir vs src file, or vice versa) the dst node is removed so
 * the follow-up `cpSync` can recreate it cleanly (`cpSync` cannot overwrite a
 * non-empty dir with a file). Presence in src is probed with `lstatSync` (no
 * symlink follow) so a broken/relative src symlink is not misread as "absent"
 * and used to prune a real dst entry.
 *
 * @param src - Source directory (repo side on pull).
 * @param dst - Destination directory (host side on pull); assumed to exist.
 * @param blockSet - Basenames to preserve at any depth (see `extrasDenySet`).
 */
function prunePreservingDenied(src: string, dst: string, blockSet: Set<string>): void {
  for (const name of readdirSync(dst)) {
    if (blockSet.has(name)) continue;
    const dstPath = join(dst, name);
    const srcStat = lstatSync(join(src, name), { throwIfNoEntry: false });
    if (srcStat === undefined) {
      rmSync(dstPath, { recursive: true, force: true });
      continue;
    }
    const dstStat = lstatSync(dstPath);
    if (srcStat.isDirectory() && dstStat.isDirectory()) {
      prunePreservingDenied(join(src, name), dstPath, blockSet);
    } else if (srcStat.isDirectory() !== dstStat.isDirectory()) {
      rmSync(dstPath, { recursive: true, force: true });
    }
  }
}

/**
 * Pull-only preserving copy variant. Unlike `copyExtras` and
 * `copyExtrasFiltered`, this function does NOT `rmSync(dst)` wholesale before
 * copying. Instead it runs a recursive prune (`prunePreservingDenied`) that
 * preserves, at any depth, every existing dst entry whose basename is in
 * `blockSet` (host-local deny-set files that push already filtered out of the
 * repo, e.g. `settings.local.json`), while still applying true-mirror deletion
 * to synced (non-deny) dst entries that are absent from src. After pruning, the
 * same filtered `cpSync` used by `copyExtrasFiltered` overwrites or creates
 * synced files (defense-in-depth: deny-set basenames from src are also stripped
 * on the copy, guarding against a repo poisoned out-of-band). A not-yet-existing
 * dst (fresh pull) is handled cleanly: the prune is skipped and cpSync creates
 * it. A dst that exists but is not a real directory (a regular file, or a
 * symlink) is removed wholesale before the copy, matching `copyExtras` root
 * semantics, so the recursive prune never `readdirSync`-follows a symlink and
 * deletes content outside the project tree. Passes `verbatimSymlinks: true` so
 * relative symlink targets are not
 * rewritten across hosts (Pitfall 1, nodejs/node issue 41693). The
 * root-src-entry-kept semantics (`srcEntry === src`) match `copyExtrasFiltered`
 * exactly. `copyExtras` and `copyExtrasFiltered` are intentionally left
 * unchanged so the push path stays an exact byte-mirror.
 *
 * @param src - Source directory to copy from (repo side on pull).
 * @param dst - Destination path (host-side project dir on pull).
 * @param blockSet - Basenames to preserve in dst and to exclude from the src
 *   copy (see `extrasDenySet`).
 */
export function copyExtrasFilteredPreserving(
  src: string,
  dst: string,
  blockSet: Set<string>,
): void {
  const dstStat = lstatSync(dst, { throwIfNoEntry: false });
  if (dstStat !== undefined) {
    // A non-directory root (file or symlink) is removed wholesale so cpSync
    // recreates it, and so the prune never readdir-follows a symlink into an
    // external tree. Only a real directory is pruned in place.
    if (dstStat.isDirectory()) prunePreservingDenied(src, dst, blockSet);
    else rmSync(dst, { recursive: true, force: true });
  }
  cpSync(src, dst, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    filter: (srcEntry) => srcEntry === src || !blockSet.has(basename(srcEntry)),
  });
}
