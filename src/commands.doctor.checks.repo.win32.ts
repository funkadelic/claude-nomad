import { existsSync } from 'node:fs';
import { join, win32 as win32Path } from 'node:path';

import { dim, green, infoGlyph, okGlyph, warnGlyph, yellow } from './color.ts';
import { deniedSegmentFor, repoHome } from './config.ts';
import { listDivergingFiles } from './extras-sync.diff.ts';

/** Return shape shared by every `classifySharedLink` branch. */
export type SharedLinkClassification = { line: string; fail: boolean; children?: string[] };

/**
 * The unconditional win32 copy-sync healthy row, reused by every OK case below.
 *
 * `exempt` counts diverging paths the compare threw out as never-synced, and is
 * named in a dim trailing note when non-zero. Which paths is deliberately left
 * unsaid (they are never-synced by definition, so naming them is not
 * actionable, and the set that boundary applies here is the credential and
 * host-config floor plus the credential-shape patterns, not ordinary
 * runtime-state directory names), but a bare OK row with a standing one-way
 * divergence behind it reads as "nothing to see" when the truth is "nothing
 * this tool will ever reconcile". Never a WARN, because no command could clear
 * it; compact mode strips passing rows either way, so this surfaces under
 * `--verbose`, where a reader is asking for detail.
 */
function win32CopyOkRow(name: string, exempt = 0): SharedLinkClassification {
  const note = exempt > 0 ? dim(` (${exempt} never-synced path(s) not compared)`) : '';
  return { line: `${green(okGlyph)} ${name}: real copy (win32 copy-sync)${note}`, fail: false };
}

/**
 * The win32 copy-sync unpublished-name row: a real local copy at
 * `~/.claude/<name>` with no `shared/<name>` counterpart in the repo.
 *
 * An info row rather than a WARN, because a deliberately host-private
 * directory is a legitimate state on every platform: `syncSharedLinksPush`
 * (`links.mirror.ts`) runs under `adoptNew: false`, so it never creates a
 * repo counterpart for a name the repo does not already carry, and a yellow
 * row here would train users to ignore a state that is often exactly what
 * they intended. It exists at all because that same policy change means a
 * push no longer creates a repo counterpart on its own: without this row,
 * the only symptom of an unpublished name is its absence on another machine,
 * with nothing on this one pointing at the cause or the fix.
 *
 * Never sets `process.exitCode`, matching every other informational Links
 * row (`not synced (nothing in shared/)`, a stale symlink, ...).
 */
function win32CopyUnpublishedRow(name: string): SharedLinkClassification {
  return {
    line: `${dim(infoGlyph)} ${name}: real local copy, not published (run \`nomad adopt ${name}\` to share it)`,
    fail: false,
  };
}

/**
 * The path from `root` down to `path`, forward-slashed, or `null` when `path`
 * is not strictly under `root`.
 *
 * Takes its path semantics from `path.win32` rather than from the host, because
 * this is reached only from `classifyWin32Copy` and the platform's own rules are
 * what make the out-of-tree cases expressible at all: `relative` across two
 * drive letters returns the destination verbatim and ABSOLUTE rather than a
 * `..` walk, so a `..` test alone reads a `D:\...` path as contained. Splicing
 * that after the `shared/<name>/` prefix would hand `deniedSegmentFor` every
 * segment of the REPO's own location, and a sync repo living under, say,
 * `D:\sessions\` would exempt every repo-only file on the host. Reading the
 * semantics from the module also lets the suite exercise the case on any host.
 *
 * An empty result means `path` IS `root`, which is what git reports for a
 * file-type shared name (`CLAUDE.md`, `my-statusline.cjs`): the file is its own
 * compare root, so there is no segment below it to return.
 *
 * @param root - One of the two absolute compare roots.
 * @param path - An absolute path taken from a `--name-status` record.
 * @returns The contained relative path, or `null` when there is none.
 */
function relativeUnder(root: string, path: string): string | null {
  const rel = win32Path.relative(root, path);
  const segments = rel.split(win32Path.sep);
  if (rel === '' || segments[0] === '..' || win32Path.isAbsolute(rel)) return null;
  return segments.join('/');
}

/**
 * One `listDivergingFiles` line rewritten as the repo-relative, forward-slashed
 * path `shared/<name>/<rest>`, which is the shape `deniedSegmentFor` expects:
 * it picks its denylist from the first two segments (see `blockSetFor`), and a
 * bare relative path with no `shared/<name>/` prefix would be classified as if
 * it sat in a different region with a different set, which is exactly the
 * failure this function exists to prevent.
 *
 * The `(local only)` / `(repo only)` side indicator is stripped first, matching
 * the exact suffixes `labelEntry` produces in `extras-sync.diff.ts`. git
 * reports a modified or local-only file under the local root and a repo-only
 * file under the repo root, so the path is relativized against whichever of the
 * two contains it, and against neither when it is contained by neither. That
 * last case yields the bare `shared/<name>`, which no denylist holds, so a path
 * this function cannot place is never exempted (see {@link relativeUnder} for
 * the two shapes that reach it).
 *
 * @param line - One line from `listDivergingFiles`.
 * @param name - The shared name being compared (`commands`, `rules`, ...).
 * @param local - Absolute `~/.claude/<name>` path passed to the compare.
 * @param shared - Absolute `shared/<name>` path passed to the compare.
 * @returns The repo-relative path, ready for `deniedSegmentFor`.
 */
function divergingRepoPath(line: string, name: string, local: string, shared: string): string {
  const path = line.replace(/ \((?:local|repo) only\)$/, '');
  const rel = relativeUnder(local, path) ?? relativeUnder(shared, path);
  return rel === null ? `shared/${name}` : `shared/${name}/${rel}`;
}

/**
 * Win32 branch of `classifySharedLink`'s non-symlink case: the real (copied)
 * file/dir at `p` is the healthy state there, but a healthy PRESENCE is not
 * the same as a healthy CONTENT. With capture-on-pull in place (see
 * `links.mirror.ts`, `links.deletions.ts`), a standing byte-level
 * divergence from `shared/<name>` means something did not reconcile, which is
 * worth a nudge before the next mutating command runs.
 *
 * Skips the compare entirely when the repo has no `shared/<name>` source:
 * there is nothing to compare against, and the row names the name as
 * unpublished. The presence probe is inlined rather than delegated to
 * `repoHasSharedSource` so the repo path it builds is computed once and reused
 * as the compare's right-hand side. The compare itself routes through
 * `listDivergingFiles`, the same byte-level `git diff --no-index` helper
 * `reportSkillsDivergence` already uses (never mtime-based, so a checkout
 * mtime rewrite cannot manufacture a false WARN), which never throws and
 * WARNs (rather than raising) when git is absent from PATH. Divergence is
 * always a WARN, never a FAIL: `process.exitCode` is left untouched exactly
 * like `reportSkillsDivergence`, per the doctor reporter contract.
 *
 * The compare's result is filtered through `deniedSegmentFor`, the same
 * boundary the host-to-repo mirror applies to this destination
 * (`mirrorOneSharedName` in `links.mirror.ts`, via `blockSetFor`): a path the
 * mirror will never copy is not reported as drift no command could clear.
 * Under a shared name that boundary is now the credential and host-config
 * floor (`ALWAYS_NEVER_SYNC`) plus the credential-shape patterns, not the
 * wider set of ordinary runtime-state directory names (`sessions`, `tasks`,
 * `plans`, ...) it used to be; those are counted as ordinary drift again,
 * because the mirror now writes them and a divergence there is one the next
 * push actually resolves. What remains exempt is content that genuinely
 * cannot cross in either direction: a credential-shaped name, or a name on
 * the five-entry floor. The test has to run over every segment rather than
 * the basename, because the floor holds directory names as well as
 * filenames, and a denied directory segment is structurally invisible to a
 * basename test.
 *
 * What the exemption costs is a signal, and the count is given back rather than
 * swallowed. Such a path is a genuine, permanent one-way divergence: the mirror
 * will never copy it, and the pull is silent about it by design, so with the
 * exemption in place no surface reports it at all. The row still reads OK,
 * because no command can clear it, but it says how many there were; the count
 * is rendered by {@link win32CopyOkRow}.
 *
 * Extracted out of `classifySharedLink` so adding this compare does not push
 * that already branch-dense function over the cognitive-complexity gate.
 *
 * @param name - The shared name being classified.
 * @param p - Absolute `~/.claude/<name>` path holding the real copy.
 * @returns The row, plus one child row per diverging file.
 */
export function classifyWin32Copy(name: string, p: string): SharedLinkClassification {
  const sharedPath = join(repoHome(), 'shared', name);
  if (!existsSync(sharedPath)) return win32CopyUnpublishedRow(name);
  const compared = listDivergingFiles(p, sharedPath);
  const diverging = compared.filter(
    (line) => deniedSegmentFor(divergingRepoPath(line, name, p, sharedPath)) === null,
  );
  const exempt = compared.length - diverging.length;
  if (diverging.length === 0) return win32CopyOkRow(name, exempt);
  return {
    line: `${yellow(warnGlyph)} ${name}: ${diverging.length} file(s) diverge from shared/${name}`,
    fail: false,
    children: diverging,
  };
}
