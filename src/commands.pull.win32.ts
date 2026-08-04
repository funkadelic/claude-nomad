/**
 * The win32-only pre-pull reconcile step, extracted from `commands.pull.ts` so
 * both halves of it (the additive mirror and the deletion pass) live beside each
 * other and neither file carries the whole thing.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { type PathMap } from './config.ts';
import { applySharedLinkDeletions } from './links.deletions.ts';
import { stageLocalSharedEdits } from './links.ts';
import { warn } from './utils.ts';
import { readPathMap } from './utils.json.ts';

/**
 * Read `path-map.json` for the win32 pre-pull reconcile, fail-safe.
 *
 * An ABSENT file yields `{ projects: {} }`, matching what `runPullCore` itself
 * falls back to further down. `allSharedLinks({ projects: {} })` is exactly the
 * static `SHARED_LINKS` set, which is all the reconcile needs, so a host whose
 * repo has no `path-map.json` yet (a clone that predates `nomad init`) still
 * gets its unpublished shared-config edits staged rather than silently reverted.
 *
 * Only an unreadable or MALFORMED file yields `null`, which both passes treat as
 * "skip me". Deliberately does NOT reuse the `readPathMap` call further down
 * `runPullCore`: that one runs after the rebase and dies fatally on a parse
 * error, which is the right behavior for the pull proper but wrong for a
 * pre-step that must never be the thing that fails a pull.
 *
 * @param mapPath - Absolute path to `REPO_HOME/path-map.json`.
 * @returns The parsed path-map, or `null` when it exists but cannot be parsed.
 */
function readMapForMirror(mapPath: string): PathMap | null {
  if (!existsSync(mapPath)) return { projects: {} };
  try {
    return readPathMap(mapPath);
  } catch {
    return null;
  }
}

/**
 * win32-only pre-pull step: make the host's own shared-config state visible in
 * the repo working tree BEFORE `git pull --rebase --autostash` runs, in both
 * directions. Additions and edits are staged into `shared/<name>`; files the
 * user deleted are removed from it.
 *
 * On posix a shared name is a symlink, so an edit to `~/.claude/CLAUDE.md` is
 * ALREADY an uncommitted change in the repo working tree when a pull starts, and
 * a file deleted inside a shared directory is ALREADY gone from the repo. The
 * autostash carries both through the rebase, `applySharedLinks` re-points the
 * same symlink, and the state is unchanged afterwards. Pull-first costs a posix
 * user nothing.
 *
 * On win32 both live only in the host-side copy. Without the mirror,
 * `applySharedLinksWin32` overwrites an edit from the repo and it survives only
 * in the backup dir; under `nomad sync` the push half then published the
 * reverted content, silently undoing the change the user ran sync to publish.
 * Without the deletion pass the mirror alone is not enough either: it is
 * additive, so the repo keeps the deleted file and the repo-to-local overlay
 * later in the same pull puts it straight back on the host.
 *
 * The deletion half is gated on the per-host baseline, which is what makes a
 * deletion distinguishable from a file this host has never received; a host with
 * no trustworthy baseline propagates no removals at all. See
 * `links.baseline.ts`.
 *
 * The mirror's write is deliberately narrower than the push mirror (no new
 * shared names, overlay rather than replace, repo-side backup first); see
 * `stageLocalSharedEdits` for why a pull cannot reuse the push policy.
 *
 * Skipped in three cases: on darwin/linux (both passes return immediately),
 * under `dryRun` (zero-mutation preview contract), and under `forceRemote`,
 * which is the deliberate "discard local, take the remote" escape hatch
 * (`recoverForceRemote` resets to `origin/main`) that reconciling host content
 * in would fight. Also a no-op when `path-map.json` is malformed.
 *
 * The map is read ONCE and shared by both passes, so they cannot disagree about
 * which names are shared. Mirror first, then deletions, so the backup cache
 * records the two in a stable order.
 *
 * @param repo - `repoHome()`, resolved once by `runPullCore`.
 * @param ts - Backup timestamp, resolved once by `runPullCore`.
 */
export function reconcileSharedLinksBeforePull(repo: string, ts: string): void {
  if (process.platform !== 'win32') return;
  try {
    const map = readMapForMirror(join(repo, 'path-map.json'));
    stageLocalSharedEdits(map, ts);
    applySharedLinkDeletions(map, ts);
  } catch (err) {
    // A pre-step must never be the thing that fails a pull. Either pass can
    // throw for reasons unrelated to the user's intent (a path over the Windows
    // limit, an antivirus lock, EPERM on a read-only repo file), and letting
    // that propagate would abort before `git pull --rebase` runs, leaving the
    // host unable to fetch at all until the local condition clears. Warn and
    // continue: the unstaged edit is still on the host, applySharedLinksWin32
    // backs it up again before overwriting it, and an unpropagated deletion is
    // simply replanned on the next run.
    warn(`could not reconcile local shared edits before the pull: ${(err as Error).message}`);
  }
}
