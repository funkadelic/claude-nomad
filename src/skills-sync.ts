import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { ALWAYS_NEVER_SYNC, claudeHome, repoHome } from './config.ts';
import { copyExtrasFiltered, copyExtrasFilteredPreservingBy } from './extras-sync.core.ts';
import { backupBeforeWrite } from './utils.fs.ts';

/** The ownership prefix shared by all gsd-installed skills, agents, and hook scripts. */
const GSD_PREFIX = 'gsd-';

/**
 * Returns `true` when a skill (or agent/hook) basename is owned by gsd rather
 * than the user. Detection is prefix-only: any name starting with `gsd-` is
 * gsd-owned. This covers all 68 gsd skills, all 33 gsd agents, and all 14
 * gsd hook scripts (the `gsd-` prefix is the one ownership signal uniform
 * across all three dirs; no manifest read, no fs access, no exec required).
 *
 * The three user-authored skills (`graphify`, `patch-coverage-check`,
 * `pr-feedback-sweep`) are unprefixed and return `false`.
 *
 * @param name - Basename of the skill/agent/hook directory or file to test.
 * @returns `true` if the name is gsd-owned; `false` if it is user-authored.
 */
export function isGsdOwned(name: string): boolean {
  return name.startsWith(GSD_PREFIX);
}

/**
 * Skills-copy exclusion predicate composing the gsd-ownership filter with the
 * `ALWAYS_NEVER_SYNC` denylist. A basename is excluded from the push mirror and
 * preserved on pull when it is either gsd-owned (the prefix) OR a hard-blocked
 * sensitive name (`settings.local.json`, `.credentials.json`, ...). The
 * `ALWAYS_NEVER_SYNC` check applies at every depth via the recursive `cpSync`
 * filter, so a stray host-config file nested inside a user skill cannot ride
 * into `shared/skills/` on push. Mirrors the extras path's `extrasDenySet`
 * boundary rather than inventing a new one (the `gitleaks` scan only catches
 * credential-shaped content; non-secret names like `settings.local.json` need
 * this name-based filter).
 *
 * @param name - Basename of a skill entry (at any depth) to test.
 * @returns `true` if the entry must be excluded/preserved.
 */
export function isSkillExcluded(name: string): boolean {
  return isGsdOwned(name) || ALWAYS_NEVER_SYNC.has(name);
}

/**
 * Push-side filtered mirror for `skills/`. Copies all non-gsd skills from
 * `src` into `dst`, mirroring the repo side. Pre-existing gsd-owned entries in
 * `dst` (stale repo entries deposited during the symlink era) are removed as
 * part of the push-side rm-then-copy so the repo reflects only user skills.
 * Passes `verbatimSymlinks: true` to keep relative symlink targets unrewritten
 * across hosts (Pitfall 1, nodejs/node issue 41693).
 *
 * Uses `copyExtrasFiltered` with a src-scanned blockSet: the push side is a
 * true mirror of the non-gsd content, so a src-derived set is safe here (no
 * dst-only preservation is needed on the push side). The rmSync-before-copy
 * inside `copyExtrasFiltered` ensures stale repo gsd-* entries from the symlink
 * era are removed.
 *
 * The blockSet unions the gsd-owned top-level names with the whole
 * `ALWAYS_NEVER_SYNC` denylist. `copyExtrasFiltered`'s `cpSync` filter tests
 * every entry's basename at every depth, so seeding the set with the denylist
 * names blocks a host-config file nested inside a user skill (WR-02), not just
 * a top-level one.
 *
 * Precondition: `src` MUST be a real directory, not a symlink. `readdirSync`
 * and the underlying `cpSync` follow a symlinked `src` root and would silently
 * mirror whatever it targets into `dst`; worse, if `src` points at `dst` the
 * rmSync-before-copy would delete the source out from under itself. The sole
 * caller (`syncSkillsPush`) enforces this with an `lstatSync(...)` symlink guard
 * before calling; any new caller must do the same.
 *
 * @param src - Source skills directory (`~/.claude/skills/` on push); must be a
 *   real directory (see precondition above).
 * @param dst - Destination skills directory (`shared/skills/` on push).
 */
export function copySkillsPush(src: string, dst: string): void {
  const srcNames = readdirSync(src, { encoding: 'utf8' });
  const blockSet = new Set<string>([
    ...srcNames.filter((n) => isGsdOwned(n)),
    ...ALWAYS_NEVER_SYNC,
  ]);
  copyExtrasFiltered(src, dst, blockSet);
}

/**
 * Pull-side preserving overlay for `skills/`. Overlays non-gsd skills from
 * `src` into `dst` WITHOUT rmSync-ing the dst root, so gsd's locally-installed
 * `gsd-*` skills in `~/.claude/skills/` are never removed. The preserve
 * decision is the `isGsdOwned` predicate itself (not a src-derived Set), so a
 * local `gsd-*` skill present ONLY in dst (absent from src) is preserved even
 * though it is not in any src-derived allow-set. Defense-in-depth: gsd-owned
 * entries present in src are also excluded from the cpSync copy, so a stale
 * `shared/skills/gsd-*` entry cannot overwrite or create a local gsd skill.
 * Passes `verbatimSymlinks: true` to keep relative symlink targets unrewritten
 * across hosts (Pitfall 1, nodejs/node issue 41693).
 *
 * Routes through `copyExtrasFilteredPreservingBy` (the predicate-driven
 * preserving-copy variant in `extras-sync.core.ts`). The FORBIDDEN alternative
 * -- building a blockSet by scanning src for gsd-* names and passing it to
 * `copyExtrasFilteredPreserving` -- is unsafe: a local gsd-* skill in dst but
 * absent from src would not be in that set and would be rmSync-deleted (a
 * Phase-49-class mirror-delete violating D-2).
 *
 * The preserve/exclude predicate is `isSkillExcluded` (gsd-ownership composed
 * with `ALWAYS_NEVER_SYNC`), mirroring the push-side boundary so a poisoned repo
 * cannot overlay a sensitive host-config name into `~/.claude/skills/` (WR-02).
 *
 * @param src - Source skills directory (`shared/skills/` on pull).
 * @param dst - Destination skills directory (`~/.claude/skills/` on pull).
 */
export function copySkillsPull(src: string, dst: string): void {
  copyExtrasFilteredPreservingBy(src, dst, isSkillExcluded);
}

/**
 * Pull-side path-resolving wrapper for `skills/` copy-sync. Resolves
 * `repoHome()`/`claudeHome()` at call time (the lazy-resolution convention),
 * then:
 *   1. Migration: if `~/.claude/skills` is a symlink (left over from the
 *      whole-dir-symlink era), back it up via `backupBeforeWrite(linkPath, ts)`
 *      and replace it with a real directory before calling `copySkillsPull`.
 *      This ensures gsd's locally-reinstalled `gsd-*` skills and the user
 *      skills can coexist in a real directory tree. The migration is idempotent:
 *      if `~/.claude/skills` is already a real directory (or absent), the
 *      backup-and-replace step is skipped.
 *   2. Overlay: calls `copySkillsPull(sharedSkills, localSkills)` to overlay
 *      non-gsd skills from `shared/skills/` into `~/.claude/skills/`,
 *      preserving local `gsd-*` skills.
 *
 * No-op when `shared/skills/` does not exist (nothing to overlay; mirrors
 * `applySharedLinks`'s skip when the repo has no `shared/<name>` counterpart).
 *
 * @param ts - Backup timestamp passed to `backupBeforeWrite` for the symlink
 *   migration. Use the pull invocation's `freshBackupTs` result.
 */
export function syncSkillsPull(ts: string): void {
  const sharedSkills = join(repoHome(), 'shared', 'skills');
  if (!existsSync(sharedSkills)) return;
  const localSkills = join(claudeHome(), 'skills');
  const dstStat = lstatSync(localSkills, { throwIfNoEntry: false });
  if (dstStat?.isSymbolicLink() === true) {
    backupBeforeWrite(localSkills, ts);
    rmSync(localSkills, { recursive: true, force: true });
    mkdirSync(localSkills, { recursive: true });
  }
  copySkillsPull(sharedSkills, localSkills);
}

/**
 * Push-side path-resolving wrapper for `skills/` copy-sync. Resolves
 * `repoHome()`/`claudeHome()` at call time, then calls
 * `copySkillsPush(localSkills, sharedSkills)` to mirror only non-gsd user
 * skills from `~/.claude/skills/` into `shared/skills/`. No-op when
 * `~/.claude/skills` does not exist.
 *
 * The push mirror is a rm-then-filtered-copy (`copyExtrasFiltered`), so stale
 * `gsd-*` entries deposited in `shared/skills/` during the symlink era are
 * removed automatically on the first `syncSkillsPush` call. No separate prune
 * step is needed; this is the one-time stale-gsd-* cleanup mechanism.
 *
 * Symlink guard: on a host upgraded post-phase-50 that has not yet pulled,
 * `~/.claude/skills` is still a live symlink into `shared/skills` (the
 * pre-phase-50 state). Pushing through it would `rmSync` the copy target out
 * from under the `cpSync` source, wiping `shared/skills` and crashing with
 * `ENOENT`. When `localSkills` is a symlink we skip the mirror entirely: the
 * next `nomad pull` migrates the link to a real dir (see `syncSkillsPull`),
 * after which push mirrors normally.
 */
export function syncSkillsPush(): void {
  const localSkills = join(claudeHome(), 'skills');
  const stat = lstatSync(localSkills, { throwIfNoEntry: false });
  if (stat === undefined) return; // absent: nothing to push
  if (stat.isSymbolicLink()) return; // pre-phase-50 live symlink; defer to next pull
  const sharedSkills = join(repoHome(), 'shared', 'skills');
  copySkillsPush(localSkills, sharedSkills);
}
