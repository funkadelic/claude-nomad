/**
 * The read-only preflight that decides whether `nomad adopt` may run at all.
 *
 * Kept out of `commands.adopt.ts` (the command controller) so the controller
 * gains no branch from this check, and kept out of `commands.adopt.recover.ts`
 * (the failure-semantics module) because nothing here has failed yet: this
 * module only reads, and it runs before the first mutation of the move.
 */

import { lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ALWAYS_NEVER_SYNC, matchDeniedName } from '../config.ts';
import { errorText } from '../error-text.ts';
import { EXIT } from '../exit-codes.ts';
import { NomadFatal } from '../utils.ts';

/**
 * One host-side entry the scan found that must never cross into `shared/`.
 *
 * `path` is relative to the scanned root and always forward-slashed, even on
 * a platform whose native separator is a backslash.
 *
 * `matched` carries the axis, and it is the field the remedy hangs off. It
 * holds the never-sync list entry the basename collided with, or `null` when
 * the basename matched a credential filename shape instead (`*.pem`,
 * `.env.local`, `id_rsa`). Only the first kind is cleared by renaming the
 * path, so a refusal that treated both alike would send a user with a
 * `server.pem` off to rename it and straight back into the same refusal. It is
 * also what makes the listing honest: on the shape axis there is no list entry
 * to quote, and quoting the basename back instead says nothing at all, while
 * on the name axis the entry and the basename differ whenever the match came
 * through the case-fold or trailing-character normalization.
 */
export type DeniedEntry = { path: string; matched: string | null };

/**
 * Replace every backslash in `p` with a forward slash, so a relative path
 * built with `node:path` on a backslash-separator platform still reads the
 * same as its posix form in a user-facing message.
 *
 * @param p A path string, possibly carrying native path separators.
 * @returns `p` with every backslash rewritten to a forward slash.
 */
function toForwardSlash(p: string): string {
  return p.replaceAll('\\', '/');
}

/**
 * Collect every denied entry under `root`.
 *
 * Iterative over an explicit stack, so how far it can descend is bounded
 * by heap rather than by the call stack. Prunes at the topmost denied
 * entry: when a directory's own basename is denied, it is pushed once and
 * never queued for listing, so a denied directory holding further denied
 * names underneath it is still reported exactly once. A `Dirent` for a
 * symlink answers `isDirectory()` false, so a symlink is never followed
 * and no cycle is reachable regardless of what it targets. That buys
 * cycle-freedom only: a symlink whose own basename is clean is neither
 * walked nor dereferenced, so its target string still gets published into
 * `shared/<name>` unexamined.
 *
 * @param root The scan root, every collected `path` is relative to it.
 * @returns Every denied entry found, in stack-pop order (unsorted).
 */
function walk(root: string): DeniedEntry[] {
  const out: DeniedEntry[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const match = matchDeniedName(ALWAYS_NEVER_SYNC, entry.name);
      if (match !== null) {
        out.push({
          path: toForwardSlash(relative(root, join(dir, entry.name))),
          matched: match.axis === 'name' ? match.entry : null,
        });
        continue;
      }
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * List every never-sync entry under `root`, sorted and pruned at the
 * topmost match.
 *
 * Returns an empty array when `root` does not exist or is not a directory:
 * a `SHARED_LINKS` member can be a single file such as `CLAUDE.md`, and
 * `readdirSync` on a file throws `ENOTDIR`, so both the absent and the
 * file-root cases are answered the same clean way rather than by letting
 * that throw escape. The root's own basename is never tested, matching
 * {@link copyExtrasFiltered}'s root-keep rule in `extras-sync.core.ts`. The
 * root is probed with `lstatSync` rather than `existsSync`, so a symlinked
 * root (already refused upstream by the precondition matrix) is answered as
 * not-a-directory here too rather than followed.
 *
 * The returned list is sorted by `path` before it is returned, so the
 * refusal message built from it reads the same regardless of filesystem
 * listing order, which `readdirSync` does not guarantee. Sorted with
 * `localeCompare` rather than a hand-written comparator: entries are unique
 * by construction (one push per matched basename), so the zero case never
 * arises in practice, and this way there is no branch to force in either
 * direction for full coverage.
 *
 * Tests every basename against `ALWAYS_NEVER_SYNC`, the credential and
 * host-config floor, rather than the full `NEVER_SYNC` set: `root` is nested
 * content under a name the user has already explicitly asked to share, the
 * same boundary `shared/extras/<logical>/` already applies to its own
 * content and for the identical reason, so an ordinary directory name
 * (`sessions`, `plans`, `tasks`, and the rest of `NEVER_SYNC`'s
 * runtime-state entries) found underneath it is not a collision. The NAME
 * being adopted is still checked against the full `NEVER_SYNC` set
 * elsewhere (`classifyDeniedName` in `config.sharedDirs.guard.ts`, backing
 * `nomad adopt`'s own name validation), so `nomad adopt sessions` is refused
 * as a name long before this scan ever runs; only nested content stopped
 * being refused.
 *
 * May throw when a directory under `root` cannot be read; converting that
 * into a reported failure is {@link refuseDeniedEntries}'s job, not this
 * function's, so a caller that wants the raw scan still gets it.
 *
 * @param root Absolute path to scan (typically `CLAUDE_HOME/<name>`).
 * @returns Every denied entry found, sorted by `path`, or `[]` when clean.
 */
export function scanDeniedEntries(root: string): DeniedEntry[] {
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return [];
  const out = walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Scan `root`, reporting a scan that could not finish as this command's own
 * refusal instead of letting the raw throw reach the crash reporter.
 *
 * @param name The name being adopted, for the message and the re-run hint.
 * @param root Absolute path to scan (`CLAUDE_HOME/<name>`).
 * @param state Produces a finished sentence saying what is on disk right now.
 *   It is a parameter because it is the one thing that differs between the two
 *   gates: the preflight has changed nothing, while the re-scan that runs after
 *   the copy has `shared/<name>` written already. It is a thunk rather than a
 *   string because the gate that has something to undo has to DO the undo
 *   before it can describe the result, and only on the arm that actually
 *   reports. Built eagerly, the failure arm here could only ever describe a
 *   state it had not reached, and would leave the caller's cleanup unrun.
 * @returns Every denied entry found, sorted by `path`, or `[]` when clean.
 * @throws {NomadFatal} `EXIT.GENERIC_FAILURE` when the scan could not finish,
 *   naming the path and quoting the caught text.
 */
export function scanOrFatal(name: string, root: string, state: () => string): DeniedEntry[] {
  try {
    return scanDeniedEntries(root);
  } catch (err) {
    // The cause is quoted rather than diagnosed. This catch is broad on
    // purpose (an unreadable directory, or an entry removed between the
    // listing and the type probe a `Dirent` resolves with), and naming one of
    // those as THE reason would send the user to check permissions that were
    // never the problem, on a retry that fails the same way.
    throw new NomadFatal(
      `cannot adopt ${name}: could not scan ${root} for never-sync content (${errorText(err)}). ` +
        `${state()} Check that it is readable and not being written to, then ` +
        `run \`nomad adopt ${name}\` again.`,
      { code: EXIT.GENERIC_FAILURE },
    );
  }
}

/**
 * Say why one hit was refused, in the terms that decide what to do about it.
 *
 * A list collision quotes the entry that matched rather than the basename the
 * user wrote: the two differ whenever the match came through the case-fold or
 * trailing-character normalization, and repeating their own spelling back at
 * them ("`Settings.local.json` matches `Settings.local.json`") carries no
 * information. A shape hit quotes nothing, because there is no list entry
 * behind it, only a filename pattern.
 *
 * @param hit One denied entry.
 * @returns The parenthetical to print after that hit's path.
 */
function describeMatch(hit: DeniedEntry): string {
  return hit.matched === null
    ? 'matches a credential filename shape'
    : `matches the never-sync name "${hit.matched}"`;
}

/**
 * The remedy sentences that apply to this particular set of hits.
 *
 * The move is unconditional and comes first: it clears every hit on either
 * axis. What follows is scoped, because the two axes do not answer to the same
 * fix and a blanket "or rename it" is wrong on one of them. A never-sync name
 * is a spelling collision with a fixed list, so a rename ends it, and saying
 * so matters because the list holds ordinary directory names (`tasks`,
 * `plans`, `cache`) that a user may legitimately own and would otherwise be
 * told to break their layout over. A credential filename shape is matched by
 * an extension or by the whole filename, so renaming a `deploy.key` to
 * `release.key` lands in an identical refusal.
 *
 * Each clause is emitted only when at least one hit is on its axis, and both
 * appear on a mixed set, so every sentence printed is true of something in the
 * listing above it. Each names its axis in the words {@link describeMatch}
 * prints on the line itself, rather than saying "it" or "those paths", so a
 * mixed listing still maps each remedy onto the exact lines it applies to.
 *
 * @param hits Every denied entry being reported.
 * @param root Absolute path the hits are relative to.
 * @param name The name being adopted, for the re-run hint.
 * @returns The remedy sentences, leading with a space.
 */
function remedies(hits: DeniedEntry[], root: string, name: string): string {
  const subject = hits.length === 1 ? 'that path' : 'those paths';
  let out = ` Move ${subject} out of ${root} and run \`nomad adopt ${name}\` again.`;
  if (hits.some((hit) => hit.matched !== null)) {
    out +=
      ' A never-sync name is matched by spelling alone and never by content, so renaming a path' +
      ' listed above as a never-sync name clears the refusal just as well.';
  }
  if (hits.some((hit) => hit.matched === null)) {
    out +=
      ' A credential filename shape is matched by the extension or by the whole filename, so' +
      ' renaming a path listed above as a credential filename shape clears the refusal only if' +
      ' the new name falls outside that shape too.';
  }
  return out;
}

/**
 * Compose the refusal a never-sync gate raises, so the two gates cannot drift
 * apart on what they list or on what they tell the user to do about it.
 *
 * Only the two clauses that genuinely differ are handed in. Everything else
 * (the listing, the singular or plural subject, the remedies, the exit code)
 * is shared, which is the whole point of building the message here rather
 * than at either call site.
 *
 * @param name The name being adopted, for the message and the re-run hint.
 * @param root Absolute path the listed hits are relative to.
 * @param hits Every denied entry to name, already sorted.
 * @param clauses.found Says what was found, with no trailing punctuation.
 * @param clauses.state A finished sentence saying what is on disk right now.
 * @returns The refusal, for the caller to throw.
 */
export function deniedEntriesRefusal(
  name: string,
  root: string,
  hits: DeniedEntry[],
  clauses: { found: string; state: string },
): NomadFatal {
  const lines = hits.map((hit) => `  ${hit.path} (${describeMatch(hit)})`).join('\n');
  return new NomadFatal(
    `cannot adopt ${name}: ${clauses.found}:\n${lines}\n` +
      `${clauses.state}${remedies(hits, root, name)}`,
    { code: EXIT.GENERIC_FAILURE },
  );
}

/**
 * Refuse `nomad adopt <name>` outright when `root` carries a never-sync
 * entry, otherwise return silently.
 *
 * This is a refusal rather than a skip because the source directory is
 * removed by the move either way: `removeAdoptSource` (in
 * `commands.adopt.recover.ts`) takes the whole tree off the host, and on
 * posix the path then becomes a symlink into `shared/`. A skipped entry
 * would therefore not merely be left out of the repo, it would be taken off
 * the host and survive only in a backup snapshot the user was never told
 * about. Refusing before anything moves keeps the claim "nothing was
 * changed" literally true.
 *
 * The same reasoning is why the copy-side filter is not the whole answer:
 * `refuseLateDeniedEntries` (in `commands.adopt.recover.ts`) runs this same
 * scan again after the copy, because an entry that arrived in between is
 * filtered out of the repo and would otherwise still be deleted off the host.
 *
 * @param name The name being adopted, for the message and the re-run hint.
 * @param root Absolute path to scan (`CLAUDE_HOME/<name>`).
 * @throws {NomadFatal} `EXIT.GENERIC_FAILURE` when the scan could not finish,
 *   or when `root` carries one or more never-sync entries, naming every
 *   offending path and the axis it matched on.
 */
export function refuseDeniedEntries(name: string, root: string): void {
  const nothingChanged = 'Nothing was changed.';
  const hits = scanOrFatal(name, root, () => nothingChanged);
  if (hits.length === 0) return;
  throw deniedEntriesRefusal(name, root, hits, {
    found: `${root} contains never-sync content`,
    state: nothingChanged,
  });
}
