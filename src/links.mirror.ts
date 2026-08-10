/**
 * The win32-only host-to-repo mirror, extracted from `links.ts` so the
 * host->repo write half lives beside itself and `links.ts` no longer carries
 * the whole thing.
 */

import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

import { allSharedLinks, claudeHome, repoHome, NEVER_SYNC, type PathMap } from './config.ts';
import { copyExtrasFiltered, copyExtrasOverlayFiltered } from './extras-sync.core.ts';
import { log } from './utils.ts';
import { backupRepoWrite } from './utils.fs.ts';

/**
 * Event emitted by the win32 host-to-repo mirror (`stageLocalSharedEdits`,
 * `syncSharedLinksPush`) when a sink is supplied: on the dry-run path via
 * `emitMirror`, and on the wet path right after the copy lands. Shaped after
 * the mirror's own capture record (`name`, `localPath`, `repoPath`) rather
 * than the posix `LinkPreviewEvent`'s `from`/`to` pair, since this event is
 * the single source for both the wet-pull `Symlinks` row and the dry-run
 * preview row.
 */
export type MirrorPreviewEvent = {
  kind: 'mirror';
  /** The shared name (`CLAUDE.md`, `commands`, ...). */
  name: string;
  /** Absolute host-side path (`~/.claude/<name>`), the copy source. */
  localPath: string;
  /** Absolute repo-side path (`shared/<name>`), the copy destination. */
  repoPath: string;
};

/**
 * Options shared by every mirror entry point. `linkNames`, when supplied,
 * is used verbatim instead of deriving the name list internally; this is
 * what lets a caller derive `allSharedLinks(map)` once per command
 * invocation instead of once per mirror call, so an invalid `sharedDirs`
 * entry WARNs exactly once per `nomad pull` or `nomad push` rather than
 * once per call site.
 */
type MirrorOpts = {
  /** When `true`, no disk mutation occurs; see `emitMirror`. */
  dryRun?: boolean;
  /** Structured-event sink; see `MirrorPreviewEvent`. */
  onPreview?: (e: MirrorPreviewEvent) => void;
  /** Pre-derived name list; falls back to `allSharedLinks(map)` when absent. */
  linkNames?: readonly string[];
};

/**
 * Emit a dry-run mirror event via `onPreview`, or fall back to `log()` when
 * no sink is supplied. Mirrors `emitCopy`'s fallback shape in `links.ts`.
 */
function emitMirror(
  onPreview: MirrorOpts['onPreview'],
  name: string,
  localPath: string,
  repoPath: string,
): void {
  if (onPreview) {
    onPreview({ kind: 'mirror', name, localPath, repoPath });
  } else {
    log(`would capture: ${localPath} -> ${repoPath}`);
  }
}

/**
 * Emit the wet-path mirror event when a sink is supplied. Deliberately no
 * `log()` fallback: a wet run with no sink attached must stay byte-silent, so
 * `syncSharedLinksPush(map)`'s existing call site and every direct-call test
 * are unaffected by this event's introduction.
 */
function emitMirrorWet(
  onPreview: MirrorOpts['onPreview'],
  name: string,
  localPath: string,
  repoPath: string,
): void {
  if (onPreview) onPreview({ kind: 'mirror', name, localPath, repoPath });
}

/** How one mirror pass treats the repo side. See the two exported wrappers. */
type SharedMirrorPolicy = {
  /** Create `shared/<name>` when the repo has no counterpart yet. */
  adoptNew: boolean;
  /** Overlay onto the repo copy instead of replacing it wholesale. */
  overlay: boolean;
  /** When set, snapshot the repo copy under `backup/<ts>/repo/` before writing. */
  backupTs?: string;
};

/**
 * Mirror one `~/.claude/<name>` into `shared/<name>` under `policy`. Extracted
 * from the loop so each of the two wrappers stays readable and the per-name
 * branch set stays well inside the cognitive-complexity threshold.
 *
 * Under `opts.dryRun`, no disk mutation occurs at all: the event is emitted
 * (via `emitMirror`) INSTEAD of copying, and no `backupRepoWrite` call fires
 * either. On the wet path, the copy happens first and the event is emitted
 * afterward only when `opts.onPreview` is supplied (`emitMirrorWet`).
 *
 * The copy filter runs against the full `NEVER_SYNC` set. Every path this
 * mirror writes lives under `shared/<name>` and never under `shared/extras/`,
 * so `blockSetFor` resolves such a path to `NEVER_SYNC` unconditionally: this
 * computes, at copy time and with no git invocation, exactly the gate the
 * repo-working-tree backstop computes for the same path afterwards. The point
 * is that the path is simply never written, leaving the backstop a genuine
 * second layer rather than the only line of defense.
 *
 * The trade-off is real and deliberate. `NEVER_SYNC` is not a generic secrets
 * list: it was authored against `~/.claude/`'s own directory semantics and
 * carries ordinary-sounding names (`todos`, `shell-snapshots`, `debug`,
 * `file-history`, `plans`, `session-env`, `statsig`, `telemetry`, `ide`,
 * `cache`, `backups`, `paste-cache`, `daemon`, `jobs`, `tasks`, `security`,
 * `sessions`). A user whose `sharedDirs` content legitimately contains a
 * directory spelled exactly like one of those stops seeing it mirrored.
 * `isDeniedName` matches whole segments, not substrings, so a FILE named
 * `tasks.md` is unaffected; only a path segment spelled exactly `tasks`
 * collides.
 *
 * @param name - Shared name from `allSharedLinks`.
 * @param claude - `claudeHome()`, resolved once by the caller.
 * @param repo - `repoHome()`, resolved once by the caller.
 * @param policy - Repo-side treatment; see {@link SharedMirrorPolicy}.
 * @param opts - `dryRun`/`onPreview`; see {@link MirrorOpts}.
 */
function mirrorOneSharedName(
  name: string,
  claude: string,
  repo: string,
  policy: SharedMirrorPolicy,
  opts: MirrorOpts,
): void {
  const localPath = join(claude, name);
  const stat = lstatSync(localPath, { throwIfNoEntry: false });
  if (stat === undefined) return; // absent: nothing to mirror
  if (stat.isSymbolicLink()) return; // symlink-era live link; defer to next pull
  const target = join(repo, 'shared', name);
  if (!policy.adoptNew && !existsSync(target)) return; // repo does not share this name

  if (opts.dryRun === true) {
    emitMirror(opts.onPreview, name, localPath, target);
    return;
  }

  if (policy.backupTs !== undefined) backupRepoWrite(target, policy.backupTs, repo);
  // Overlay is directory-only (`copyExtrasOverlayFiltered` walks the source with
  // readdirSync). A SHARED_LINKS FILE entry like CLAUDE.md has no repo-only
  // sibling to preserve in the first place, so the plain filtered copy IS the
  // overlay for it, and routing files here keeps the primitive's contract intact.
  if (policy.overlay && stat.isDirectory()) {
    copyExtrasOverlayFiltered(localPath, target, NEVER_SYNC);
  } else {
    copyExtrasFiltered(localPath, target, NEVER_SYNC);
  }
  emitMirrorWet(opts.onPreview, name, localPath, target);
}

/**
 * Shared win32 host-to-repo mirror driving both `syncSharedLinksPush` and
 * `stageLocalSharedEdits`. The platform and null-map gates live here so both
 * callers can invoke their wrapper unconditionally with no branch of their own,
 * matching `applySharedLinks`'s win32-gating convention.
 *
 * @param map - Parsed `path-map.json`, or `null` to skip the pass entirely.
 * @param policy - Repo-side treatment; see {@link SharedMirrorPolicy}.
 * @param opts - `dryRun`/`onPreview`/`linkNames`; see {@link MirrorOpts}.
 */
function mirrorSharedNames(
  map: PathMap | null,
  policy: SharedMirrorPolicy,
  opts: MirrorOpts = {},
): void {
  if (process.platform !== 'win32') return;
  if (map === null) return;
  const claude = claudeHome();
  const repo = repoHome();
  const linkNames = opts.linkNames ?? allSharedLinks(map);
  for (const name of linkNames) {
    mirrorOneSharedName(name, claude, repo, policy, opts);
  }
}

/**
 * Win32 push-mirror for `allSharedLinks(map)` names: copies each real local
 * copy at `~/.claude/<name>` back into `shared/<name>` (repo side), so an
 * edit made through the win32 copy model (`applySharedLinksWin32` in
 * `links.ts`) reaches the repo at the next push. This is the write half of
 * the copy-sync model; `copySharedLinkPull` in `links.ts` is the read half.
 *
 * Mirrors `syncSkillsPush`'s pattern exactly: skip a name absent from
 * `~/.claude/` (nothing to mirror), skip a name that is still a live symlink
 * (a symlink-era leftover, or a host sharing `~/.claude` with a
 * symlink-capable OS; mirroring through it would rm the copy target from
 * under the `cpSync` source and crash), otherwise mirror via
 * `copyExtrasFiltered` with a blockSet seeded from `NEVER_SYNC`, so a
 * host-local sensitive name cannot ride from `~/.claude/` into the repo. See
 * `mirrorOneSharedName` for why that set and not the narrower subset
 * `copySharedLinkPull` still uses on the repo-to-host read half.
 *
 * On darwin/linux this is a no-op: the symlink means an edit at
 * `~/.claude/<name>` already lands in `shared/<name>` directly, so push has
 * nothing to mirror. The platform gate lives inside the function (an early
 * return) so callers can invoke it unconditionally with no branch of their
 * own, matching `applySharedLinks`'s win32-gating convention.
 *
 * `map` is nullable to match `loadSelectionForPush`'s return shape (a missing
 * `path-map.json` yields `map: null`); a null map skips the mirror entirely
 * rather than crashing on `allSharedLinks(null)`. The caller's own
 * `path-map.json missing` fatal fires later in the real-push pipeline.
 *
 * `opts.linkNames`, when supplied, is used verbatim instead of deriving the
 * name list from `map` internally, so `cmdPush` can derive it once and thread
 * it through instead of every call site re-deriving it (which would
 * re-emit any `sharedDirs` rejection WARN once per call).
 *
 * @param map - Parsed `path-map.json`, or `null` when the file is absent.
 * @param opts - `linkNames`; see {@link MirrorOpts}. `dryRun`/`onPreview` are
 *   accepted for signature symmetry with `stageLocalSharedEdits` but are not
 *   exercised by the real-push-only call site today.
 */
export function syncSharedLinksPush(map: PathMap | null, opts: MirrorOpts = {}): void {
  mirrorSharedNames(map, { adoptNew: true, overlay: false }, opts);
}

/**
 * Pull-side counterpart of `syncSharedLinksPush`: make the host's own
 * `~/.claude/<name>` edits visible in the repo working tree BEFORE
 * `git pull --rebase --autostash` runs, so the autostash carries them through
 * the rebase exactly as a posix symlink already does. See
 * `reconcileSharedLinksBeforePull` in `commands.pull.win32.ts` for why the
 * pull needs this at all.
 *
 * Deliberately does NOT reuse the push policy. A push is an explicit publish
 * that the user asked for, and it is followed by the allow-list gate and the
 * gitleaks scan; a pull is neither, so it runs under the two conservative
 * settings instead:
 *
 * - `adoptNew: false`, so a name the repo does not already share is left alone.
 *   Creating `shared/<name>` from a purely host-local dir would turn a pull
 *   into a publish trigger (under `nomad sync` the push half would ship it to
 *   every other host), and it would invert the guarantee `applySharedLinks`
 *   enforces: a host with no `shared/<name>` counterpart keeps its private
 *   local copy.
 * - `overlay: true`, so a repo-side file the host copy happens to lack is not
 *   deleted. The goal here is only that a host EDIT is present for the rebase,
 *   not that the repo becomes a byte-exact mirror of the host; byte-exact
 *   mirroring belongs to the push, where the user asked for it.
 *
 * `backupTs` additionally snapshots each repo-side copy under
 * `backup/<ts>/repo/` first, so an uncommitted working-tree edit under
 * `shared/` stays recoverable (git cannot recover it: it was never committed).
 *
 * `opts.dryRun` (default `false`): when `true`, no disk mutation occurs at
 * all; a `MirrorPreviewEvent` is emitted per name instead (through
 * `opts.onPreview` when supplied, otherwise a `log()` fallback line).
 *
 * `opts.onPreview`: structured-event sink. On the dry-run path it receives
 * one event per name that would be mirrored. On the wet path it receives one
 * event per name actually mirrored, right after the copy lands; with no sink
 * supplied, the wet path stays silent (no log fallback), matching the
 * pre-existing contract every direct call to this function already relies on.
 *
 * `opts.linkNames`, when supplied, is used verbatim instead of deriving the
 * name list from `map` internally.
 *
 * @param map - Parsed `path-map.json`, or `null` when it could not be read.
 * @param ts - Backup timestamp, already resolved by `runPullCore`.
 * @param opts - `dryRun`/`onPreview`/`linkNames`; see {@link MirrorOpts}.
 */
export function stageLocalSharedEdits(
  map: PathMap | null,
  ts: string,
  opts: MirrorOpts = {},
): void {
  mirrorSharedNames(map, { adoptNew: false, overlay: true, backupTs: ts }, opts);
}
