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

import { isDeniedName, NEVER_SYNC } from './config.ts';
import { EXIT } from './exit-codes.ts';
import { NomadFatal } from './utils.ts';

/**
 * One host-side entry the scan found that must never cross into `shared/`.
 *
 * `path` is relative to the scanned root and always forward-slashed, even on
 * a platform whose native separator is a backslash. `segment` is the
 * basename that matched the deny set, named separately so a refusal can say
 * WHICH name did it rather than only where it is.
 */
export type DeniedEntry = { path: string; segment: string };

/**
 * Replace every backslash in `p` with a forward slash, so a relative path
 * built with `node:path` on a backslash-separator platform still reads the
 * same as its posix form in a user-facing message.
 *
 * @param p A path string, possibly carrying native path separators.
 * @returns `p` with every backslash rewritten to a forward slash.
 */
function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Recursively collect denied entries under `dir`, appending to `out`.
 *
 * Prunes at the topmost denied entry: when a directory's own basename is
 * denied, it is pushed once and never recursed into, so a denied directory
 * holding further denied names underneath it is still reported exactly once.
 * A `Dirent` for a symlink answers `isDirectory()` false, so a symlink is
 * never followed and no cycle is reachable regardless of what it targets.
 *
 * @param root The scan root, held constant across the recursion so every
 *   collected `path` is relative to the same base.
 * @param dir The directory currently being listed (`root` on the first call).
 * @param out Accumulator every match is pushed onto.
 */
function walk(root: string, dir: string, out: DeniedEntry[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (isDeniedName(NEVER_SYNC, entry.name)) {
      out.push({
        path: toForwardSlash(relative(root, join(dir, entry.name))),
        segment: entry.name,
      });
      continue;
    }
    if (entry.isDirectory()) walk(root, join(dir, entry.name), out);
  }
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
 * listing order, which `readdirSync` does not guarantee. Entries are unique
 * by construction (one push per matched basename), so the comparator never
 * needs an equality arm.
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
  const out: DeniedEntry[] = [];
  walk(root, root, out);
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
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
 * @param name The name being adopted, for the message and the re-run hint.
 * @param root Absolute path to scan (`CLAUDE_HOME/<name>`).
 * @throws {NomadFatal} `EXIT.GENERIC_FAILURE` when `root` could not be read,
 *   naming the path and quoting the caught text, so an unreadable host tree
 *   is reported as this command's own failure rather than a crash report.
 * @throws {NomadFatal} `EXIT.GENERIC_FAILURE` when `root` carries one or more
 *   never-sync entries, naming every offending path and its matched segment.
 */
export function refuseDeniedEntries(name: string, root: string): void {
  let hits: DeniedEntry[];
  try {
    hits = scanDeniedEntries(root);
  } catch (err) {
    // Restated rather than imported: `errorText` in `commands.adopt.recover.ts`
    // is not exported, and this is the only other caller that needs its
    // shape, so duplicating the two lines here is cheaper than adding a
    // cross-module export for one consumer.
    const message = (err as Error | undefined)?.message;
    const text = typeof message === 'string' ? message : String(err);
    throw new NomadFatal(
      `cannot adopt ${name}: could not scan ${root} for never-sync content (${text}). ` +
        `Nothing was changed. Check its permissions, then run \`nomad adopt ${name}\` again.`,
      { code: EXIT.GENERIC_FAILURE },
    );
  }
  if (hits.length === 0) return;

  const lines = hits
    .map((hit) => `  ${hit.path} (matches never-sync name "${hit.segment}")`)
    .join('\n');
  const subject = hits.length === 1 ? 'that path' : 'those paths';
  throw new NomadFatal(
    `cannot adopt ${name}: ${root} contains never-sync content:\n${lines}\n` +
      `Nothing was changed. Move ${subject} out of ${root} and run \`nomad adopt ${name}\` again.`,
    { code: EXIT.GENERIC_FAILURE },
  );
}
