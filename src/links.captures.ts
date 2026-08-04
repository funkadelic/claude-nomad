/**
 * Read-only planner mirroring the win32 pre-pull mirror's per-name capture
 * gates (`mirrorOneSharedName` in `links.ts`, invoked by `stageLocalSharedEdits`
 * under its `adoptNew: false` policy), so the dry-run preview and `nomad diff`
 * can show exactly which shared names a real pull would copy from
 * `~/.claude/` into `shared/`, without importing or duplicating the mirror
 * itself.
 *
 * There is no shared implementation between this predicate and the mirror:
 * the mirror's gates live inside `mirrorOneSharedName` in the over-cap
 * `links.ts`, which also drives the push mirror (`syncSharedLinksPush`), so
 * refactoring it to consume a planner would pull the push path into this
 * read-only preview slice. Instead this module reproduces the same gate
 * order, and `links.captures.test.ts` pins the two together with an
 * equivalence test: it runs this planner and the real mirror over the same
 * fixture and asserts the planner's name set equals the set of names the
 * mirror actually wrote. If a gate is added to or dropped from either side,
 * that test fails.
 *
 * Unconditional, like the mirror: a name is captured whether or not its
 * bytes differ from the repo copy, matching the win32 `would copy` preview
 * row `applySharedLinksWin32` already emits with no content compare of its
 * own. A content compare belongs to the doctor drift check, not here.
 */

import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

import { allSharedLinks, claudeHome, repoHome, type PathMap } from './config.ts';

/** One shared name the win32 pre-pull mirror would copy into the repo. */
export type SharedLinkCapture = {
  /** The shared name (`CLAUDE.md`, `commands`, ...). */
  name: string;
  /** Absolute host-side path (`~/.claude/<name>`), the copy source. */
  localPath: string;
  /** Absolute repo-side path (`shared/<name>`), the copy destination. */
  repoPath: string;
};

/**
 * Plan which shared names the win32 pre-pull mirror (`stageLocalSharedEdits`)
 * would copy from `~/.claude/` into `shared/`. Pure and read-only: it
 * mutates nothing, so a caller can render it as a preview.
 *
 * Returns an empty plan on darwin and linux (checked first, so posix pays
 * nothing) and on a `null` map. Otherwise walks `allSharedLinks(map)` and
 * skips a name whose local path is absent, whose local path cannot be
 * stat'ed at all, whose local path is a live symlink (a symlink-era leftover
 * the mirror defers to the next pull), or that has no `shared/<name>`
 * counterpart in the repo yet (matching the mirror's `adoptNew: false`
 * policy: a pull never creates a brand-new shared name).
 *
 * The stat is wrapped because `throwIfNoEntry: false` suppresses ENOENT
 * only; EACCES, EPERM and EIO still throw. This planner is reached by
 * `nomad diff` and by `pull --dry-run`, whose whole value is being safe to
 * run, so a locked file must degrade to one missing preview row rather than
 * a crash report.
 *
 * @param map - Parsed `path-map.json`, or `null` when it could not be read.
 * @returns One entry per name the mirror would copy; empty when nothing qualifies.
 */
export function planSharedLinkCaptures(map: PathMap | null): SharedLinkCapture[] {
  if (process.platform !== 'win32') return [];
  if (map === null) return [];
  const claude = claudeHome();
  const repo = repoHome();
  const plan: SharedLinkCapture[] = [];
  for (const name of allSharedLinks(map)) {
    const localPath = join(claude, name);
    let stat;
    try {
      stat = lstatSync(localPath, { throwIfNoEntry: false });
    } catch {
      continue; // unreadable: the mirror cannot promise anything about it
    }
    if (stat === undefined) continue; // absent: nothing to capture
    if (stat.isSymbolicLink()) continue; // symlink-era leftover; deferred to next pull
    const repoPath = join(repo, 'shared', name);
    if (!existsSync(repoPath)) continue; // repo does not share this name yet
    plan.push({ name, localPath, repoPath });
  }
  return plan;
}
