import { basename } from 'node:path';

import { gitCaptureRaw } from './utils.ts';

/**
 * Returns the basenames of every top-level entry tracked under `shared/skills/`
 * at `ref` in the `repo` git checkout. This is the "skills I had at my last
 * sync" signal used to distinguish a never-pushed local skill (root entry
 * absent from this set: retain) from one genuinely deleted upstream since the
 * last sync (root entry present in this set but absent from the post-rebase
 * `shared/skills/`: prune).
 *
 * Uses `git ls-tree --name-only -z <ref> -- shared/skills/`. The trailing
 * slash on `shared/skills/` is load-bearing: without it git returns the
 * directory path itself as a single tree entry instead of listing its
 * children. Omitting `-r` keeps the listing non-recursive, which is exactly
 * the top-level skill-name granularity this decision needs.
 *
 * Fail-safe by design: returns an empty `Set` when `shared/skills/` does not
 * exist at `ref`, or when the underlying git call throws for any reason (bad
 * ref, not a git repo, etc.). An empty result means "retain everything at the
 * root", the same safe default `remapExtrasPull` uses when `prePostHeads` is
 * unavailable.
 *
 * @param ref - Git ref (typically the pre-rebase HEAD) to read the tree at.
 * @param repo - Absolute path to the git checkout (`repoHome()`).
 * @returns Set of top-level `shared/skills/` basenames tracked at `ref`.
 */
export function trackedRootSkillsAt(ref: string, repo: string): Set<string> {
  try {
    const raw = gitCaptureRaw(['ls-tree', '--name-only', '-z', ref, '--', 'shared/skills/'], repo);
    const entries = raw.split('\0').filter((entry) => entry !== '');
    return new Set(entries.map((entry) => basename(entry)));
  } catch {
    return new Set();
  }
}
