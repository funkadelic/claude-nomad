/**
 * The one shared answer to "what is at this path", used everywhere a caller
 * needs to tell absent apart from a broken pointer apart from a genuine stat
 * failure. Three surfaces in this codebase (doctor, `nomad adopt`, and the
 * win32 push mirror) answered this question with two different probes and
 * disagreed on exactly one state: a symlink whose target does not resolve.
 * This leaf exists so a fourth call site never repeats that disagreement.
 *
 * Dependency-free leaf module, mirroring `config.never-sync.ts`,
 * `exit-codes.ts` and `user-abort.ts`: zero imports, safe for any other
 * module to import without creating a cycle.
 */
import { existsSync, lstatSync } from 'node:fs';

/**
 * The four states a path can be in, distinguishing "nothing here" from
 * "something here, but the wrong kind of something" without following a
 * symlink until it is safe to.
 *
 * A `type` alias rather than an enum: `erasableSyntaxOnly` forbids real
 * TypeScript enums, and every existing classifier in this codebase
 * (`NameClass` in `commands.eject.ts`) already uses a string-literal union
 * for the same reason.
 */
export type PresenceState = 'absent' | 'resolves' | 'dangling' | 'unknown';

/**
 * Classify what is at `p`, without following a symlink further than needed
 * to tell the four states apart.
 *
 * Follows `classifyName`'s idiom in `commands.eject.ts`: `lstatSync` first
 * (so a symlink is detected as an entry even when its target is gone), then
 * `existsSync` (which follows the link) decides whether that entry resolves.
 *
 * The `unknown` fallback is deliberate and is the opposite direction from the
 * `lexists` copies already in this codebase (`commands.adopt.recover.ts`,
 * `commands.eject.ts`), which fold every thrown error, including a genuine
 * permissions failure, into "absent". A path that cannot be stat-ed for any
 * reason OTHER than not existing is reported present-but-unknown here,
 * matching `presentAt`'s fallback direction in `links.mirror.ts`: guessing
 * absent would hand a caller a claim it cannot support, and at the push
 * boundary specifically, guessing absent is exactly what lets an unreadable
 * entry vanish from a mirror pass without a word.
 *
 * @param p - Absolute path to probe.
 * @returns The classified state; see {@link PresenceState}.
 */
export function classifyPresence(p: string): PresenceState {
  let stat;
  try {
    stat = lstatSync(p, { throwIfNoEntry: false });
  } catch {
    return 'unknown';
  }
  if (stat === undefined) return 'absent';
  return existsSync(p) ? 'resolves' : 'dangling';
}

/**
 * True for the two states a caller cannot safely treat as either "nothing to
 * do" (`absent`) or "use it normally" (`resolves`): a dangling pointer, and a
 * path that could not be classified at all. Extracted as its own named
 * predicate, rather than inlined as `state === 'dangling' || state ===
 * 'unknown'` at each call site, so both operands are exercised in one place
 * ({@link ../fs-presence.test.ts}) instead of partially at every consumer,
 * which is what a 100% patch-coverage gate needs from a disjunction reused
 * across several files.
 *
 * @param state - A {@link PresenceState} returned by {@link classifyPresence}.
 * @returns `true` when the state is `dangling` or `unknown`.
 */
export function isUnusableTarget(state: PresenceState): boolean {
  return state === 'dangling' || state === 'unknown';
}

/**
 * Whether anything occupies `p` at all, without following a symlink to
 * decide. `false` only for `absent`; `true` for a resolving entry, a
 * dangling symlink, and a path that could not be classified (the
 * present-but-unknown fallback described on {@link classifyPresence}).
 *
 * @param p - Absolute path to probe.
 * @returns `true` unless `classifyPresence(p)` is `absent`.
 */
export function lexists(p: string): boolean {
  return classifyPresence(p) !== 'absent';
}
