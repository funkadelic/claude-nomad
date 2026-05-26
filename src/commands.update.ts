import { existsSync } from 'node:fs';

import { cmdDoctor } from './commands.doctor.ts';
import { currentBranch, headSha, reinstallIfNeeded } from './commands.update.git.ts';
import { defaultPrompt, tryAutoResolveMergeConflict } from './commands.update.resolve.ts';
import { REPO_HOME } from './config.ts';
import { commitRegeneratedLockfile, precommitForkExtras } from './update.fork-extras.ts';
import { loadTopology } from './update.topology.ts';
import { die, gitOrFatal, gitStatusPorcelainZ, log, warn } from './utils.ts';

/**
 * Caller-supplied options for `cmdUpdate`. All flags optional; defaults are
 * conservative (no dirty-tree override, prompt for fork push, mutate state).
 */
export type CmdUpdateOpts = {
  /** When true, run topology detection + pre-flight only; print would-be git
   * commands without mutating the repo. Skips the trailing `cmdDoctor` call. */
  dryRun?: boolean;
  /** When true, proceed even when `gitStatusPorcelainZ(REPO_HOME)` is
   * non-empty. Emits a WARN log line before continuing. */
  force?: boolean;
  /** Fork topology only: when true, push the post-merge HEAD to `origin/main`
   * without prompting. When false/unset, the user is prompted y/N. */
  pushOrigin?: boolean;
  /** Test injection point for the interactive y/N prompt. Production code
   * reads one line from `/dev/tty`; tests override this to return a
   * deterministic answer without a real controlling terminal. */
  prompt?: (question: string) => string;
};

/**
 * Perform a vanilla update by fast-forward pulling `origin/main`.
 *
 * Non-ff pulls (someone else pushed in the meantime) surface as `NomadFatal`
 * via `gitOrFatal`. If `opts.dryRun` is true, logs the would-be pull command
 * instead of executing it. Takes the full `CmdUpdateOpts` so the signature
 * stays symmetric with `runFork` even though only `dryRun` is consulted
 * today.
 *
 * @param opts - Update options; only `dryRun` is observed for this topology.
 * @returns `true` when this path already ran `npm install` and committed the merged lockfile (so the caller should skip `reinstallIfNeeded`). Vanilla `--ff-only` pulls never conflict, so this is always `false`.
 */
function runVanilla(opts: CmdUpdateOpts): boolean {
  if (opts.dryRun === true) {
    log('DRY-RUN: would run `git pull --ff-only origin main`');
    return false;
  }
  gitOrFatal(['pull', '--ff-only', 'origin', 'main'], 'git pull', REPO_HOME);
  return false;
}

/**
 * Perform a fork-style update by fetching from `upstream`, merging `upstream/main` into `main`, and optionally pushing the merge to `origin`.
 *
 * The prompt step is gated by `pushOrigin` (no prompt when explicit) and by
 * `dryRun` (no prompt, no push when previewing). When `opts.dryRun === true`
 * the function only logs the git actions it would perform and returns
 * without running any commands. When `opts.pushOrigin === true` the function
 * pushes to `origin/main` without prompting; otherwise it prompts (via
 * `opts.prompt` if provided, or the default `/dev/tty` prompt) and only
 * pushes when the answer is `y` or `yes` (case-insensitive). Non-affirmative
 * answers skip the push and log a "run later" hint.
 *
 * When the merge (and any extras precommit) leaves `HEAD` unchanged from
 * `beforeSha`, there is nothing new to push: the function logs a one-line
 * "already in sync" and returns without pushing or prompting (issue #66). An
 * auto-resolved conflict always advances `HEAD` via its merge commit, so that
 * path is never mistaken for a no-op.
 *
 * @param opts - Update options; respected fields are:
 *   - `dryRun`: when true, log actions instead of executing them
 *   - `pushOrigin`: when true, push to `origin/main` without prompting
 *   - `prompt`: optional prompt function used for interactive confirmation
 * @param beforeSha - `HEAD` SHA captured before the fork update began; the
 *   post-merge `HEAD` is compared against it to detect a no-op. When omitted
 *   (dry-run preview) the no-op short-circuit is skipped.
 */
function runFork(opts: CmdUpdateOpts, beforeSha?: string): boolean {
  const promptFn = opts.prompt ?? defaultPrompt;
  if (opts.dryRun === true) {
    log('DRY-RUN: would run `git fetch upstream`');
    log('DRY-RUN: would run `git merge upstream/main`');
    if (opts.pushOrigin === true) {
      log('DRY-RUN: would run `git push origin main`');
    } else {
      log('DRY-RUN: would prompt before pushing to origin/main');
    }
    return false;
  }
  gitOrFatal(['fetch', 'upstream'], 'git fetch upstream', REPO_HOME);
  // Pre-commit whitelisted extras (issue #112): otherwise untracked
  // shared/extras/ content that upstream also adds makes the merge abort
  // pre-merge with no UU state, so the lone-lockfile auto-resolve never fires.
  precommitForkExtras();
  let autoResolved = false;
  try {
    gitOrFatal(['merge', 'upstream/main'], 'git merge upstream/main', REPO_HOME);
  } catch (err) {
    if (!tryAutoResolveMergeConflict(opts)) throw err;
    autoResolved = true;
  }
  // No-op merge (and no extras precommit): HEAD never moved, so there is
  // nothing new to push. A `beforeSha` of undefined (dry-run never reaches
  // here) can never equal a real SHA, so the comparison is self-guarding.
  if (headSha() === beforeSha) {
    log('already in sync with origin/main, nothing to push');
    return autoResolved;
  }
  if (opts.pushOrigin === true) {
    gitOrFatal(['push', 'origin', 'main'], 'git push origin main', REPO_HOME);
    return autoResolved;
  }
  const answer = promptFn(
    'Push merge to origin/main? (y publishes to your private mirror so other hosts see it; N keeps it local) [y/N] ',
  ).toLowerCase();
  if (answer === 'y' || answer === 'yes') {
    gitOrFatal(['push', 'origin', 'main'], 'git push origin main', REPO_HOME);
  } else {
    log('skipping push to origin (run `git push origin main` later)');
  }
  return autoResolved;
}

/**
 * Perform a topology-aware repository update.
 *
 * Detects `vanilla` (`origin` -> public) vs `fork` (`upstream` -> public,
 * `origin` -> private mirror) layouts, runs the right git invocation, runs
 * `npm install` only when `package-lock.json` changed in the update, and
 * ends with `cmdDoctor()` so the version-check PASS line confirms the
 * upgrade landed.
 *
 * Pre-flight (each fatal unless overridden):
 *   1. `REPO_HOME` exists.
 *   2. Topology resolves to `vanilla` or `fork`.
 *   3. `--push-origin` is fork-only (rejected on `vanilla`).
 *   4. Current branch is `main`.
 *   5. Working tree clean per `gitStatusPorcelainZ` (override with `force`).
 *
 * Fork-topology prompts read one line from `/dev/tty`; tests inject
 * `opts.prompt` to bypass the TTY read.
 *
 * @param opts - Update options. `dryRun` runs pre-flight + logs the would-be git, install, and doctor actions without mutating the repo or invoking `cmdDoctor`. `force` proceeds past a dirty working tree. `pushOrigin` (fork topology only) skips the y/N prompt. `prompt` injects a synchronous answer function for tests.
 */
export function cmdUpdate(opts: CmdUpdateOpts = {}): void {
  if (!existsSync(REPO_HOME)) die(`repo not cloned at ${REPO_HOME}`);

  const topology = loadTopology();
  if (topology === 'unknown') {
    die(
      `could not detect upstream remote in ${REPO_HOME}. Run \`git fetch <remote>\` and \`git merge <remote>/main\` manually.`,
    );
  }

  if (topology === 'vanilla' && opts.pushOrigin === true) {
    die('`--push-origin` is only valid for fork topology');
  }

  const branch = currentBranch();
  if (branch !== 'main') {
    die(`current branch is \`${branch}\`, expected \`main\``);
  }

  const status = gitStatusPorcelainZ(REPO_HOME);
  if (status.length > 0) {
    if (opts.force !== true) {
      die('working tree is not clean, use `--force` to override');
    }
    warn('working tree is not clean, proceeding because --force was passed');
  }

  log(`topology: ${topology}`);

  if (opts.dryRun === true) {
    if (topology === 'vanilla') runVanilla(opts);
    else runFork(opts);
    log('DRY-RUN: would run `npm install` only if `package-lock.json` changed');
    log('DRY-RUN: would run `nomad doctor` to confirm the upgrade');
    return;
  }

  const beforeSha = headSha();
  const installAlreadyRan = topology === 'vanilla' ? runVanilla(opts) : runFork(opts, beforeSha);

  if (!installAlreadyRan) reinstallIfNeeded(beforeSha);
  // Secondary item of issue #112: a post-merge `npm install` that regenerated
  // package-lock.json leaves uncommitted drift the trailing doctor flags.
  // Commit just the lockfile (fork topology only) so the repo is clean.
  if (topology === 'fork') commitRegeneratedLockfile();
  cmdDoctor();
}
