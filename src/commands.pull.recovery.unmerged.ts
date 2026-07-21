import { EXIT } from './exit-codes.ts';
import { orphanedAutostashPresent } from './commands.pull.wedge.ts';
import { die, gitOrFatal, log } from './utils.ts';
import { gitCapture, parseDirtyPaths } from './commands.pull.recovery.git.ts';

/**
 * Recover from the unmerged-index-no-active-rebase wedge state under
 * `nomad pull --force-remote`.
 *
 * This is a DISTINCT, smaller recovery path than `recoverForceRemote`. There
 * is no active rebase or merge to abort and (in the common case) no diverged
 * commits to park. The stuck index is the only problem.
 *
 * Steps:
 * 1. Record which paths the index reports as unmerged, BEFORE clearing it.
 *    After the reset they are indistinguishable from ordinary unstaged edits,
 *    so this is the only point at which they can be identified.
 * 2. `git reset --mixed HEAD` - clears the unmerged stage-2/3 entries while
 *    preserving working-tree content. NOT `--hard` (would discard edits) and
 *    NOT `--merge` (unpredictable for the pure stuck-index case).
 * 3. If an orphaned autostash entry is present in `git stash list`, emit a
 *    note with `git stash pop` (restore) / `git stash drop` (discard) hints.
 *    Never auto-pop: auto-popping risks re-introducing the original
 *    conflict mid-recovery.
 * 4. If any formerly-unmerged path is still present as a dirty or untracked
 *    working-tree entry, die. The index is already repaired at this point, so
 *    the repo is unwedged and the user is free to resolve at the git level;
 *    nothing is applied to `~/.claude/`.
 * 5. Otherwise return void; control falls back to cmdPull, whose subsequent
 *    `git pull --rebase --autostash` now runs cleanly.
 *
 * Step 4 is what stops `--force-remote` from applying unresolved conflict
 * content. The reset clears the index but cannot remove `<<<<<<<` / `=======` /
 * `>>>>>>>` markers already written into the working tree, and the follow-up
 * `git pull --rebase --autostash` stashes those bytes, pulls over them, and
 * pops them back cleanly, so nothing downstream would notice before
 * `applySharedLinks` published them to the live config.
 *
 * The residual probe spans BOTH tracked and untracked entries. A conflicted
 * path that HEAD does not contain (modify/delete, delete side won) is left
 * untracked by the reset, so a tracked-only probe reports a clean tree while
 * the unresolved file sits on disk waiting to be published.
 *
 * @param repo Absolute path to REPO_HOME.
 */
export function recoverUnmergedIndex(repo: string): void {
  // Step 1: the unmerged set is only observable while the index is still stuck.
  // Scoping the residual check to these paths keeps unrelated local edits in
  // the sync repo (which pull handles fine) from blocking the recovery.
  const conflicted = new Set(
    gitCapture(['diff', '--diff-filter=U', '--name-only', '-z'], repo).split('\0').filter(Boolean),
  );
  // Step 2: clear the stuck index (--mixed preserves working-tree content).
  gitOrFatal(['reset', '--mixed', 'HEAD'], 'git reset --mixed HEAD', repo);
  // Porcelain, NOT `git diff --name-only`: a conflicted path that HEAD does not
  // contain (modify/delete, where the delete side won) becomes UNTRACKED after
  // the reset, and an unstaged-tracked-only diff cannot see it. Its unresolved
  // content is still on disk and would be published by the pull, so the probe
  // has to span both states. Porcelain also covers the staged corner (a file
  // `git add`-ed after a partial resolution).
  //
  // untrackedAll is required because this matches EXACT paths: the default
  // porcelain collapses a wholly untracked directory to one `dir/` record, so
  // a conflicted `dir/config.json` (upstream deleted the whole directory) would
  // never match and would slip through.
  const { tracked, untracked } = parseDirtyPaths(repo, { untrackedAll: true });
  const present = new Set([...tracked, ...untracked]);
  const residual = [...conflicted].filter((p) => present.has(p));
  // Step 3: surface orphaned autostash if present, but never auto-pop. Emitted
  // before the step-4 die so the hint is visible alongside the refusal.
  if (orphanedAutostashPresent(repo)) {
    log(
      'orphaned autostash preserved in the stash list; ' +
        'run "git stash pop" to restore or "git stash drop" to discard it, ' +
        'then re-run "nomad pull"',
    );
  }
  // Step 4: fail closed rather than publish conflict content to ~/.claude/.
  if (residual.length > 0) {
    die(
      'index cleared, but these files still carry unresolved conflict content ' +
        'from the torn-down rebase or merge:\n' +
        residual.map((p) => `  ${p}`).join('\n') +
        '\n\nThe repo is no longer wedged, so nothing else is blocked. Nothing was ' +
        'applied to ~/.claude/: pulling now would publish that content to your ' +
        'live config.\n\n' +
        'Resolve each file above (remove any <<<<<<< / ======= / >>>>>>> markers ' +
        'and keep the content you want; a file left untracked was deleted upstream, ' +
        'so keep or delete it deliberately), commit or checkout the result, then ' +
        're-run "nomad pull".',
      { code: EXIT.CONFLICT },
    );
  }
}
