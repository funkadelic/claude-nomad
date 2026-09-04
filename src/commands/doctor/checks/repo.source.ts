/**
 * The repo-side half of `nomad doctor`'s Links classification: what the sync
 * repo's own `shared/<name>` turns out to be, and which row that implies.
 *
 * Split out of `commands.doctor.checks.repo.ts` so that reporter carries the
 * host-side probing and the section assembly, and this carries the one
 * question every row about the repo side has to ask first. Both of its
 * exports are reached only from `classifySharedLink` and
 * `classifySymlinkTarget`; nothing else in the tree calls them.
 */

import { join } from 'node:path';

import { failGlyph, red, warnGlyph, yellow } from '../../../color.ts';
import { repoHome } from '../../../config.ts';
import type { SharedLinkClassification } from './repo.win32.ts';
import { classifyPresence, isUnusableTarget, type PresenceState } from '../../../fs-presence.ts';

/**
 * The classified state of the repo's own `shared/<name>`, resolved through the
 * shared presence leaf rather than through `existsSync`.
 *
 * Every Links row that says anything about the repo side is entitled to
 * exactly what this returns and no more: `existsSync` follows a symlink, so it
 * reads a broken pointer and an unreadable path alike as "nothing there", which
 * is what let two rows make claims the probe never supported.
 *
 * @param name - A shared name (`commands`, `rules`, ...).
 * @returns The state of `shared/<name>`; see `classifyPresence`.
 */
function repoSourceState(name: string): PresenceState {
  return classifyPresence(join(repoHome(), 'shared', name));
}

/**
 * Why `nomad adopt` would refuse this name, phrased for the state actually
 * observed at `shared/<name>` and naming the remedy that state supports.
 *
 * Split per state rather than sharing one unusable-entry clause because the
 * two do not support the same sentence. A pointer that does not resolve was
 * read, and can be removed or repaired; a path that could not be stat-ed was
 * never shown to point anywhere, so saying it "does not resolve" claims a
 * read that did not happen, and whatever blocked the probe usually blocks the
 * suggested removal too. `repoSourceUnusableRow` below splits the same way for
 * the same reason.
 *
 * @param name - A shared name (`commands`, `rules`, ...).
 * @param state - The unusable state observed at `shared/<name>`.
 * @returns The trailing clause, without the leading glyph or name.
 */
function adoptRefusalClause(name: string, state: PresenceState): string {
  if (state === 'dangling') {
    return `shared/${name} does not resolve, so \`nomad adopt ${name}\` would refuse (remove shared/${name}, or restore what it points at, first)`;
  }
  return `shared/${name} could not be read, so \`nomad adopt ${name}\` would refuse (check its permissions in the sync repo first)`;
}

/**
 * The collision row: a real host entry AND a live `shared/<name>` both hold
 * content for the same name, so there are two copies and adopt will not pick
 * one.
 *
 * Split from the plain adopt recommendation because `resolves` is the one
 * repo-side state where adopt refuses for a reason that is not a defect.
 * `assertNoClobber` answers this state with `already exists; would clobber.
 * Remove it first.`, which is the SAFE answer: the host copy and the adopted
 * content have diverged independently, and moving either one over the other
 * silently destroys a copy nothing else holds. So the row names the collision
 * and hands the choice back, rather than naming a command that would refuse.
 *
 * Both remedies are destructive in one direction, which is exactly why neither
 * is performed automatically, and why the row tells the reader to compare
 * before choosing.
 *
 * @param name - A shared name (`commands`, `rules`, ...).
 * @returns The FAIL row naming the collision and both manual remedies.
 */
function adoptWouldClobberRow(name: string): SharedLinkClassification {
  return {
    line:
      `${red(failGlyph)} ${name}: NOT a symlink (blocks sync), and shared/${name} already holds ` +
      `content, so \`nomad adopt ${name}\` would refuse rather than choose between them ` +
      `(compare the two, then either remove ~/.claude/${name} and run \`nomad pull\`, or remove ` +
      `shared/${name} and run \`nomad adopt ${name}\`)`,
    fail: true,
  };
}

/**
 * The posix non-symlink row: a real file or directory sits where a symlink
 * into the sync repo belongs, which blocks sync on that platform.
 *
 * Three remedies, because `nomad adopt` is the fix only when the repo side has
 * ROOM for the name. When `shared/<name>` is there but unusable, adopt refuses
 * outright, so naming it as the fix sends the user at a command that cannot
 * run; that refusal arm splits again per state, via {@link adoptRefusalClause}.
 * When `shared/<name>` resolves, adopt refuses for a different and legitimate
 * reason, handled by {@link adoptWouldClobberRow}. Only an ABSENT repo side
 * leaves adopt able to do what this row asks of it.
 *
 * The severity does not move with the wording: a real entry where a symlink
 * belongs blocks sync on posix in every arm, so every arm keeps `fail: true`.
 *
 * The win32 sibling of this state is `classifyWin32Copy`, which reaches the
 * same conclusion through its own rows; this exists so the two platforms stop
 * describing one on-disk state with two different remedies. Note win32 needs no
 * collision arm of its own: under the copy modality a real local copy beside a
 * resolving `shared/<name>` is the HEALTHY state, and that classifier compares
 * the two and reports divergence instead of recommending anything.
 *
 * @param name - A shared name (`commands`, `rules`, ...).
 * @returns The FAIL row, worded for whether adopt could actually help.
 */
export function posixNonSymlinkRow(name: string): SharedLinkClassification {
  const state = repoSourceState(name);
  if (isUnusableTarget(state)) {
    return {
      line: `${red(failGlyph)} ${name}: NOT a symlink (blocks sync), and ${adoptRefusalClause(name, state)}`,
      fail: true,
    };
  }
  if (state === 'resolves') return adoptWouldClobberRow(name);
  return {
    line: `${red(failGlyph)} ${name}: NOT a symlink (blocks sync); run \`nomad adopt ${name}\` to fix`,
    fail: true,
  };
}

/**
 * The cross-platform unusable-repo-source row, shared by both
 * `classifySharedLink`'s and `classifySymlinkTarget`'s ENOENT branches: the
 * host has nothing at `~/.claude/<name>` (or a symlink that no longer
 * resolves), and the repo's own `shared/<name>` is no use either, so there is
 * nothing to restore from in either direction.
 *
 * One builder serves both consumers because the actionable fact is
 * identical regardless of which branch reached it: the repo's own source is
 * unusable. Duplicating the string per consumer would give two wordings to
 * keep in step for no gain.
 *
 * Replaces two rows that were each wrong for this state, not merely terse:
 * `not synced (nothing in shared/)` is false, because the repo does carry an
 * entry (it is just unusable), and `missing (run \`nomad pull\` to restore)`
 * names a command that cannot help, because `copySharedLinkPull` copies FROM
 * `shared/<name>`, and there is nothing usable there to copy. A WARN, never a
 * FAIL: `fail: false` leaves `process.exitCode` untouched, matching every
 * other Links row that means "run a follow-up command". A WARN also
 * survives the default compact rendering, which is what this state needs: the
 * info row it used to fall through to was stripped unless the reader asked
 * for the full tree.
 *
 * Two wordings, because the two unusable states support different claims and
 * different remedies. A pointer that does not resolve can be removed or
 * repaired; a path that could not be stat-ed was never shown to point
 * anywhere, and whatever stopped the probe reading it usually stops a removal
 * too, so that arm names the permissions instead.
 *
 * Reached from every platform, unlike the win32-only dangling row in
 * `commands.doctor.checks.repo.win32.ts`: both `classifySharedLink` and
 * `classifySymlinkTarget` run their ENOENT branch on posix and win32 alike.
 *
 * @param name - A shared name (`commands`, `rules`, ...).
 * @param state - The unusable state observed at `shared/<name>`.
 * @returns The WARN row naming the unusable repo source.
 */
function repoSourceUnusableRow(name: string, state: PresenceState): SharedLinkClassification {
  if (state === 'dangling') {
    return {
      line: `${yellow(warnGlyph)} ${name}: shared/${name} in the repo does not resolve, so there is nothing to restore from (remove shared/${name}, or restore what it points at)`,
      fail: false,
    };
  }
  return {
    line: `${yellow(warnGlyph)} ${name}: shared/${name} in the repo could not be read, so whether there is anything to restore from could not be determined (check its permissions in the sync repo)`,
    fail: false,
  };
}

/**
 * Pick the row for a host path that is absent or no longer resolves, based on
 * what the repo's own `shared/<name>` turns out to be.
 *
 * `applySharedLinks` only creates a link when the repo carries a source, so
 * with no source at all an absent host entry is expected rather than a
 * problem, and with a live source it is a real out-of-sync state. The third
 * possibility, a source that is there but unusable, is neither, and used to be
 * answered by `existsSync`, which follows the link and so reported both
 * `dangling` and `unknown` as "nothing in shared/", a positive claim about a
 * path it had not read. Routing all three through the classifier is what makes
 * these rows agree with `classifyWin32Copy`, which already keys the same
 * decision off the same states.
 *
 * @param name - A shared name (`commands`, `rules`, ...).
 * @param present - The row for a live, resolving `shared/<name>`.
 * @param absent - The row for no `shared/<name>` at all.
 * @returns One of the two supplied rows, or the unusable-source row.
 */
export function repoSourceRow(
  name: string,
  present: SharedLinkClassification,
  absent: SharedLinkClassification,
): SharedLinkClassification {
  const state = repoSourceState(name);
  if (isUnusableTarget(state)) return repoSourceUnusableRow(name, state);
  return state === 'resolves' ? present : absent;
}
