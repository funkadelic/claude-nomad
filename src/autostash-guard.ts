/**
 * Shared guard for the conflicted-autostash-pop state.
 *
 * `git pull --rebase --autostash` exits 0 when the autostash POP itself
 * conflicts, even though the pull as a whole did not succeed cleanly: the
 * index is left unmerged, `stash@{0}: autostash` is retained, and conflict
 * markers are written into the working file. There is no rebase or merge
 * marker to find (`.git/rebase-merge`, `.git/rebase-apply`, and
 * `MERGE_HEAD` are all absent by the time the pop runs), so the only
 * reliable signal at this point is the unmerged index.
 *
 * Because the exit code is 0, neither `rebaseBeforePush` nor `runPullCore`
 * throws on the pull call itself, and (before this module) neither
 * re-probed after the pull returned. This module is the missing re-probe,
 * shared by both call sites so the runbook text has one source of truth.
 *
 * This module probes `probeUnmergedIndex` directly rather than
 * `classifyWedge`: at this call site the pull has just returned, so no
 * rebase/merge marker can be present (a conflicted autostash pop happens
 * after the rebase itself already finished and tore its markers down), and
 * the message here is specific to the autostash-pop case rather than the
 * generic torn-down-rebase wording `unmergedIndexRunbookText` uses. It uses
 * the three-state probe (not the fail-open `unmergedIndexPresent`) so a probe
 * error aborts fail-closed instead of waving conflict markers through.
 */

import { orphanedAutostashPresent, probeUnmergedIndex } from './commands/pull/wedge.ts';
import { EXIT } from './exit-codes.ts';
import { NomadFatal } from './utils.ts';

/**
 * Build the fatal runbook text for a conflicted autostash pop. Deliberately
 * does NOT reuse `unmergedIndexRunbookText`: that text describes a
 * torn-down rebase and its step 1 is `git reset --mixed HEAD`, which is
 * actively wrong here (it clears the index but leaves the conflict-marker
 * text behind as unstaged modifications, which is the whole failure mode
 * this guard closes). The text never recommends a rebase abort either
 * (there is no rebase in progress in this state, so `git rebase --abort`
 * fails with "no rebase in progress").
 *
 * @param resumeCmd The `nomad <subcommand>` to re-run after manual recovery.
 * @param stashRetained Whether `stash@{0}: autostash` is present. When
 *   `true`, the recovery walks the user through extracting the
 *   pre-conflict content from the stash before discarding the markered
 *   working tree. When `false`, no stash entry was found, so the working
 *   tree is the only copy of the edit and the destructive hard reset is
 *   withheld; the user is told to resolve the markers by hand instead.
 * @returns The actionable runbook string for `NomadFatal`.
 */
export function autostashConflictRunbookText(resumeCmd: string, stashRetained: boolean): string {
  const head =
    `${resumeCmd} reported success, but the autostash pop it ran internally conflicted. ` +
    'The working tree now holds conflict markers and the index is unmerged. Nothing has ' +
    'been copied to ~/.claude/ yet, and there is no rebase or merge in progress to abort.';
  if (stashRetained) {
    return (
      `${head}\n\n` +
      'Recovery (the pre-conflict content is retained in the stash; nothing is lost):\n' +
      '  1. git stash list                 (confirm stash@{0}: autostash is present)\n' +
      "  2. git show 'stash@{0}:<path>'     (view the pre-conflict content; does not " +
      're-trigger the conflict)\n' +
      '  3. git reset --hard HEAD           (discard the markered working tree)\n' +
      '  4. re-apply the content from step 2 into <path>, as needed\n' +
      '  5. git stash drop                  (once you are done with the stash entry)\n' +
      `  6. ${resumeCmd}`
    );
  }
  return (
    `${head}\n\n` +
    'No autostash entry was found to recover from, so the working tree is the only copy ' +
    'of this edit. Resolve the conflict markers by hand in the affected file(s), then:\n' +
    '  1. git add <path>                  (mark resolved)\n' +
    `  2. ${resumeCmd}\n\n` +
    'Do not run "git reset --hard": with no stash entry to fall back on, that would ' +
    'discard your only copy of the edit.'
  );
}

/**
 * Re-probe `repo` for a conflicted autostash pop immediately after a
 * `git pull --rebase --autostash` call returns. Returns silently ONLY when the
 * probe definitively reports a clean index. Throws `NomadFatal` with `code`
 * `EXIT.CONFLICT` and the {@link autostashConflictRunbookText} message when the
 * index has unmerged entries.
 *
 * Fail-closed: unlike the wedge-detection callers, an `'error'` probe outcome
 * (git absent, index unreadable) is treated as "assume conflict, abort" rather
 * than "assume clean". This guard is the sole barrier stopping conflict-markered
 * config from being deep-merged into the live `~/.claude/settings.json` after a
 * silently-conflicted autostash pop, so it must never wave through an
 * undeterminable index.
 *
 * `orphanedAutostashPresent` is consulted ONLY when the index is definitively
 * `'unmerged'`. On an `'error'` outcome it is deliberately NOT called: it runs
 * its own `git stash list`, which would hang the same way the index probe just
 * did (the probe's timeout would be defeated by a second unbounded git call on
 * the very path meant to handle a wedged git). In the `'error'` case
 * `stashRetained` therefore defaults to `false`, selecting the no-stash runbook
 * that withholds the destructive hard reset.
 *
 * @param repo Absolute path to the repository root just pulled.
 * @param resumeCmd The `nomad <subcommand>` the caller is running, threaded
 *   into the runbook text.
 */
export function assertNoAutostashConflict(repo: string, resumeCmd: string): void {
  const probe = probeUnmergedIndex(repo);
  if (probe === 'clean') return;
  const stashRetained = probe === 'unmerged' && orphanedAutostashPresent(repo);
  throw new NomadFatal(autostashConflictRunbookText(resumeCmd, stashRetained), {
    code: EXIT.CONFLICT,
  });
}
