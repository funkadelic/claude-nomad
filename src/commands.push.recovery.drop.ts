/**
 * Lock-free session drop helper for the push-time recovery menu.
 * `dropSessionFromStaged` removes a session's generated copies from the
 * `REPO_HOME/shared/projects/` tree so the recovery loop's subsequent
 * `git add -A` stages the deletion rather than re-staging the file.
 *
 * Kept separate from `commands.push.recovery.actions.ts` to respect the
 * ~220-line module cap.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import type { PathMap } from './config.ts';
import { repoHome } from './config.ts';

/**
 * Remove the session's generated copies from the staged tree under
 * `REPO_HOME/shared/projects/<logical>/` so the subsequent `git add -A` in
 * the recovery loop stages the deletion rather than re-staging the file.
 *
 * Removes both the flat `<sid>.jsonl` transcript and the sibling subagent
 * directory `<sid>/` (if present) for every logical project in `map`. These
 * are generated copies produced by `remapPush`; the originals under
 * `~/.claude/projects/` are never touched.
 *
 * Lock-free by design: the caller (`dispatchActions`) runs inside a `push`
 * that already holds the global nomad lock. Calling `cmdDropSession` here
 * would deadlock on the lock it already owns.
 *
 * @param sid Session id to drop from the staged tree.
 * @param map Parsed path-map; provides the logical project names.
 * @returns True when `map.projects` has at least one logical entry (the
 *   session copies were targeted for removal), false when the map is empty
 *   and no paths were evaluated.
 */
export function dropSessionFromStaged(sid: string, map: PathMap): boolean {
  const logicals = Object.keys(map.projects);
  if (logicals.length === 0) return false;
  // Resolve root once per invocation (T-45-02 TOCTOU mitigation).
  const repo = repoHome();
  for (const logical of logicals) {
    const jsonl = join(repo, 'shared', 'projects', logical, `${sid}.jsonl`);
    const dir = join(repo, 'shared', 'projects', logical, sid);
    rmSync(jsonl, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
  return true;
}
