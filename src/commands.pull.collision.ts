/**
 * The win32 mirror-collision runbook.
 *
 * On native Windows the pre-pull mirror copies the host's own shared config
 * into the sync repo before the fetch, so an unpublished edit is carried
 * through the rebase the way a posix symlink already carries it. A file the
 * user created that the repo does not have lands in `shared/<name>/...` as an
 * UNTRACKED file. When the incoming update adds that same path, git refuses the
 * fast-forward:
 *
 *     error: The following untracked working tree files would be overwritten by merge:
 *             shared/commands/mine.md
 *     Please move or remove them before you merge.
 *
 * That outcome is safe and stays safe: HEAD does not advance, no stash is
 * created, and nothing reaches `~/.claude/`. There is no pre-check here that
 * changes it and no automatic retry.
 *
 * What is NOT safe is git's advice. "Move or remove them" names nomad's copy
 * inside the sync repo, and under nomad that advice loops: the mirror re-copies
 * the local file into the repo before every fetch, so removing only the repo
 * copy reproduces the identical error on the next run. The only recoveries
 * start at the file under `~/.claude/`. This module says so, and removes the
 * copy nomad itself made so the runbook is one step instead of two.
 */

import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { claudeHome } from './config.ts';
import { EXIT } from './exit-codes.ts';
import { gitProbe } from './git-probe.ts';
import { isSafeRelPath } from './rel-path-guard.ts';
import { gitOrFatal, NomadFatal, warn } from './utils.ts';

/** Repo-relative prefix every mirrored shared-config copy sits under. */
const SHARED_PREFIX = /^shared\//;

/** Matches a basename's extension, or the empty string when it has none. */
const EXTENSION = /(\.[^.]+)?$/;

/**
 * Render a repo-relative mirrored path as the `~/.claude/` original it was
 * copied from. The original is the file the user actually has to act on, so it
 * is the only path the runbook ever names.
 *
 * @param repoRel - Repo-relative path such as `shared/commands/mine.md`.
 * @returns The host-side display path, e.g. `~/.claude/commands/mine.md`.
 */
function localOriginal(repoRel: string): string {
  return `~/.claude/${repoRel.replace(SHARED_PREFIX, '')}`;
}

/**
 * Suggest a non-colliding name for `localPath`, by inserting `.local` before
 * its extension (`mine.md` becomes `mine.local.md`; an extensionless `mine`
 * becomes `mine.local`). Used only as the parenthetical example in the
 * merge-both runbook, so it needs to read naturally rather than guarantee the
 * suggestion is unused.
 *
 * @param localPath - A `~/.claude/...` display path.
 * @returns The suggested basename.
 */
function renameSuggestion(localPath: string): string {
  const base = localPath.slice(localPath.lastIndexOf('/') + 1);
  return base.replace(EXTENSION, '.local$1');
}

/**
 * The two numbered recoveries, both starting at the file under `~/.claude/`.
 * Split out of {@link untrackedCollisionRunbookText} so neither half carries
 * every singular/plural decision at once.
 *
 * @param locals - Host-side display paths, at least one.
 * @returns The runbook block, with no trailing newline.
 */
function collisionSteps(locals: readonly string[]): string {
  const single = locals.length === 1;
  const target = single ? locals[0] : 'each file listed above';
  const rename = single ? renameSuggestion(locals[0]) : 'mine.md becomes mine.local.md';
  const combine = single ? 'combine the two files' : 'combine each pair';
  return (
    'Keep the incoming version (yours is set aside, not deleted):\n' +
    `  1. move ${target} outside ~/.claude/\n` +
    '  2. nomad pull\n\n' +
    'Keep both and merge them yourself:\n' +
    `  1. rename ${target} to a name the repo does not use (${rename})\n` +
    "  2. nomad pull                      (brings in the other machine's version)\n" +
    `  3. ${combine}, then nomad push`
  );
}

/**
 * The paragraph that overrides git's own advice, which is correct for bare git
 * and a loop under nomad. Split out of {@link untrackedCollisionRunbookText}
 * because it carries three singular/plural decisions of its own.
 *
 * @param single - Whether exactly one copy collided.
 * @param cleared - Whether every colliding copy is actually gone from the repo.
 *   False when a removal failed, which on Windows is a live case rather than a
 *   theoretical one (an antivirus or editor lock), and the user has to be told:
 *   a leftover blocks the next fetch on its own, so a message that claimed the
 *   cleanup happened would send them through the steps below only to land back
 *   on this same error.
 * @returns The paragraph, with no trailing newline.
 */
function collisionAdvice(single: boolean, cleared: boolean): string {
  const copies = single ? "nomad's copy" : "nomad's copies";
  const them = single ? 'it' : 'them';
  const fate = cleared
    ? 'which nomad has now removed for you'
    : `which nomad could not remove (the warning above says why), so delete ${them} by hand if ` +
      'the next pull stops here again';
  const moving = single
    ? 'Moving only that copy would not have cleared this anyway: the next pull re-copies your ' +
      'local file over it before fetching. The file to move is the one under ~/.claude/.'
    : 'Moving only those copies would not have cleared this anyway: the next pull re-copies your ' +
      'local files over them before fetching. The files to move are the ones under ~/.claude/.';
  return `Git's advice above refers to ${copies} inside the sync repo, ${fate}. ${moving}`;
}

/**
 * Build the fatal text for a mirror collision. Deliberately does not reuse or
 * echo git's own wording: git's advice is correct for bare git and wrong here,
 * and repeating it would send the user back around the same loop.
 *
 * Paragraphs are single logical lines (the terminal soft-wraps them), matching
 * the shape `autostashConflictRunbookText` established; only the file list and
 * the numbered steps carry explicit newlines.
 *
 * @param repoRelPaths - Repo-relative paths of the colliding mirrored copies,
 *   at least one. Named in the message as their `~/.claude/` originals.
 * @param cleared - Whether every one of those copies is actually gone from the
 *   repo now. Passed through to {@link collisionAdvice}.
 * @returns The actionable runbook string for `NomadFatal`.
 */
export function untrackedCollisionRunbookText(
  repoRelPaths: readonly string[],
  cleared: boolean,
): string {
  const locals = repoRelPaths.map(localOriginal);
  const single = locals.length === 1;
  const claim = single
    ? 'One of those copies has the same name as a file the incoming update also adds:'
    : 'Each of the copies below has the same name as a file the incoming update also adds:';
  const intact = single
    ? 'Your file is still exactly as you left it.'
    : 'Your files are still exactly as you left them.';
  const listed = locals.map((p) => `  ${p}`).join('\n');
  return (
    'nomad pull could not fetch. Your machine had unpublished shared-config edits, so nomad ' +
    'copied them into the sync repo first, the way an edit on macOS or Linux is already in the ' +
    `repo before a pull starts. ${claim}\n\n` +
    `${listed}\n\n` +
    'Nothing changed. Your ~/.claude/ config is untouched, the update did not land, and nothing ' +
    `was published. ${intact}\n\n` +
    `${collisionAdvice(single, cleared)}\n\n` +
    collisionSteps(locals)
  );
}

/**
 * Narrow the paths this run's mirror created down to the ones the update that
 * just came over the wire actually adds, which is what makes a collision a
 * collision.
 *
 * `FETCH_HEAD` is the discriminator because the fetch half of `git pull`
 * completes before the checkout refuses: on a real collision it names the
 * commit that carries the incoming file, so the path resolves under it.
 *
 * A failure that never reached the remote at all (offline, bad URL, auth) cannot
 * produce a false collision, and the reason is stronger than "the file is
 * missing": git TRUNCATES `FETCH_HEAD` to zero bytes when a fetch fails rather
 * than leaving the previous successful fetch's entry in place (verified against
 * git 2.53). So even a repo that fetched cleanly minutes ago resolves nothing
 * here, and an unrelated pull failure stays on the ordinary error path instead
 * of being reported as a name collision it is not.
 *
 * A mirrored path cannot be in HEAD (it would be tracked, and this set is
 * untracked by construction), so resolving under `FETCH_HEAD` means the
 * incoming update adds it.
 *
 * @param repo - Absolute path to the sync repo just pulled in.
 * @param created - Repo-relative paths this run's mirror created.
 * @returns The subset the incoming update also adds; empty when none do or the
 *   probe could not answer.
 */
function addedByIncomingUpdate(repo: string, created: readonly string[]): string[] {
  return created.filter((rel) => gitProbe(['cat-file', '-e', `FETCH_HEAD:${rel}`], repo) !== null);
}

/**
 * Whether `rel` is a path this module is allowed to unlink: repo-relative,
 * traversal-free, and under `shared/`.
 *
 * The paths reaching the removal already come from a `-- shared/` pathspec, but
 * that containment is the caller's and lives several functions upstream. This
 * re-asserts it at the only place it actually matters, one line from the
 * `rmSync`, so the removal stays contained no matter how the created set is
 * produced later. The `shared/` prefix plus a traversal-free relative path is
 * the whole guarantee: `join(repo, rel)` cannot then land outside
 * `<repo>/shared/`, on either platform (`isSafeRelPath` also rejects the
 * backslash that would otherwise separate segments on Windows).
 *
 * @param rel - Repo-relative candidate path.
 * @returns true when the path is safe to remove.
 */
export function isContainedMirrorPath(rel: string): boolean {
  return rel.startsWith('shared/') && isSafeRelPath(rel);
}

/**
 * Whether the repo file at `rel` is still byte-identical to the `~/.claude/`
 * file the mirror copies it from.
 *
 * The created set is a difference between two `ls-files` snapshots taken around
 * the mirror, which proves a path became untracked during the step, NOT that
 * this mirror is what wrote it. Anything else writing under `shared/` in that
 * window is indistinguishable, and the removal below would delete it. Content
 * equality closes that gap without any new bookkeeping: the mirror's whole job
 * is to make the repo copy equal the local original, so a genuine copy passes
 * by construction, while a file some other hand put there has to match a local
 * file it never came from.
 *
 * Both reads are treated as a NO on failure (a missing original, an unreadable
 * file), which keeps the ambiguous case pointing at "leave it alone".
 *
 * @param repo - Absolute path to the sync repo.
 * @param rel - Repo-relative path under `shared/`.
 * @returns true when the two files exist and their bytes match.
 */
function matchesLocalOriginal(repo: string, rel: string): boolean {
  try {
    const local = join(claudeHome(), rel.replace(SHARED_PREFIX, ''));
    return readFileSync(join(repo, rel)).equals(readFileSync(local));
  } catch {
    return false;
  }
}

/**
 * Remove nomad's own mirrored copies from the repo working tree, so the next
 * `nomad pull` is not blocked a second time by the leftovers of this one.
 *
 * Safe because these are copies: the originals are still under `~/.claude/`,
 * untouched, and the mirror recreates them on the next run. Files only, never a
 * directory and never recursively, so a mistake in the created-set computation
 * cannot escalate into a tree removal. Each removal is contained on its own, so
 * one unreadable or locked path does not abandon the rest. Two guards decide
 * what is eligible at all: {@link isContainedMirrorPath} for where the path may
 * point, {@link matchesLocalOriginal} for whether this mirror is plausibly what
 * put it there.
 *
 * @param repo - Absolute path to the sync repo.
 * @param repoRelPaths - Repo-relative paths to remove. Anything
 *   {@link isContainedMirrorPath} rejects is skipped rather than removed.
 * @returns Whether every one of those paths is now gone. Reported rather than
 *   assumed because the caller's message tells the user the cleanup happened,
 *   and a leftover blocks the next fetch by itself. Answered by looking at the
 *   tree afterwards, so a skip counts the same as a failed removal: what matters
 *   downstream is what is still there, not why.
 */
function removeMirroredCopies(repo: string, repoRelPaths: readonly string[]): boolean {
  for (const rel of repoRelPaths.filter(isContainedMirrorPath)) {
    const abs = join(repo, rel);
    try {
      if (lstatSync(abs, { throwIfNoEntry: false })?.isFile() !== true) continue;
      if (!matchesLocalOriginal(repo, rel)) continue;
      rmSync(abs, { force: true });
    } catch (err) {
      warn(`could not remove nomad's copy at ${abs}: ${(err as Error).message}`);
    }
  }
  return repoRelPaths.every((rel) => !existsSync(join(repo, rel)));
}

/**
 * Run the pull's `git pull --rebase --autostash`, replacing git's own advice
 * with {@link untrackedCollisionRunbookText} when the failure is a collision
 * against a copy this run's mirror made.
 *
 * Every other failure rethrows untouched, including a failure on a host where
 * the mirror created nothing (`mirrored` empty, no probe runs at all) and a
 * failure that never reached the remote. Those keep today's behavior: git's
 * stderr, already forwarded by `gitOrFatal`, followed by `git pull --rebase
 * failed`.
 *
 * @param repo - Absolute path to the sync repo.
 * @param mirrored - Repo-relative paths this run's pre-pull mirror created
 *   under `shared/`; empty on posix, under dry-run, and under force-remote.
 */
export function pullWithCollisionRunbook(repo: string, mirrored: readonly string[]): void {
  try {
    gitOrFatal(['pull', '--rebase', '--autostash'], 'git pull --rebase', repo);
  } catch (err) {
    const colliding = addedByIncomingUpdate(repo, mirrored);
    if (colliding.length === 0) throw err;
    const cleared = removeMirroredCopies(repo, colliding);
    throw new NomadFatal(untrackedCollisionRunbookText(colliding, cleared), {
      code: EXIT.GENERIC_FAILURE,
    });
  }
}
