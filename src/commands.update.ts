import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';

import { cmdDoctor } from './commands.doctor.ts';
import { REPO_HOME } from './config.ts';
import { commitRegeneratedLockfile, precommitForkExtras } from './update.fork-extras.ts';
import { loadTopology } from './update.topology.ts';
import { die, gitOrFatal, gitStatusPorcelainZ, log, NomadFatal, warn } from './utils.ts';

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
 * Get the current Git branch name for the repository at REPO_HOME.
 *
 * Wraps the failure path so a corrupt or missing `.git` directory surfaces as
 * ``✗ ...`` via the top-level dispatcher's `NomadFatal` catch
 * rather than a raw `ExecException` stack trace.
 *
 * @returns The current branch name (trimmed).
 * @throws NomadFatal when the git command fails; if the command produced stderr, that stderr is written to process.stderr before the exception is thrown.
 */
function currentBranch(): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  } catch (err) {
    const e = err as Error & { stderr?: Buffer };
    if (e.stderr) process.stderr.write(e.stderr);
    throw new NomadFatal('git rev-parse --abbrev-ref HEAD failed');
  }
}

/**
 * Default y/N prompt used when `opts.prompt` is not injected.
 *
 * Reads from `/dev/tty` byte-by-byte until newline so the call returns after
 * the user presses Enter (cooked-mode TTY line buffering). The naive
 * `readFileSync(0)` approach reads until EOF, which hangs interactive use
 * until Ctrl-D. Opening `/dev/tty` directly also means the prompt still
 * works when stdin is piped or redirected.
 *
 * @param question - Prompt text written to stdout before reading input.
 * @returns The user's trimmed answer; `''` on any failure (no controlling TTY, read error), which `runFork` treats as "no" and skips the push.
 */
function defaultPrompt(question: string): string {
  process.stdout.write(question);
  let fd: number;
  try {
    fd = openSync('/dev/tty', 'r');
  } catch {
    return '';
  }
  try {
    const buf = Buffer.alloc(1);
    let answer = '';
    while (true) {
      const n = readSync(fd, buf, 0, 1, null);
      if (n === 0) break;
      const ch = buf.toString('utf8', 0, 1);
      if (ch === '\n' || ch === '\r') break;
      answer += ch;
    }
    return answer.trim();
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

/**
 * Read and return the current `HEAD` commit SHA from the repository.
 *
 * Used to pin the pre-update commit so the post-update lockfile diff is
 * exact regardless of whether the pull was a fast-forward, a no-op, or a
 * merge. `HEAD@{1}` is unreliable here: a no-op `git pull --ff-only` does
 * not always write a reflog entry, and a freshly cloned repo has no
 * `HEAD@{1}` at all.
 *
 * @returns The `HEAD` commit SHA as a trimmed string.
 * @throws NomadFatal if `git rev-parse HEAD` fails (stderr is written to stderr when present).
 */
function headSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  } catch (err) {
    const e = err as Error & { stderr?: Buffer };
    if (e.stderr) process.stderr.write(e.stderr);
    throw new NomadFatal('git rev-parse HEAD failed');
  }
}

/**
 * List files changed between the given commit and the current HEAD.
 *
 * @param beforeSha - Commit SHA to compare against HEAD
 * @returns An array of file paths changed between `beforeSha` and `HEAD`; an empty array if there are no changes
 */
function changedFilesSince(beforeSha: string): string[] {
  const out = execFileSync('git', ['diff', '--name-only', `${beforeSha}..HEAD`], {
    cwd: REPO_HOME,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  return out.split('\n').filter((line) => line !== '');
}

/**
 * Run `npm install` in the repository only if `package-lock.json` changed since a given commit.
 *
 * If `package-lock.json` did not change between `beforeSha` and `HEAD`, logs
 * a skip message; otherwise runs `npm install` with working directory set to
 * `REPO_HOME`. Routing through `execFileSync` (no shell) keeps the call
 * mockable in tests and prevents any chance of argv injection.
 *
 * @param beforeSha - Commit SHA to compare against `HEAD` when determining whether the lockfile changed
 */
function reinstallIfNeeded(beforeSha: string): void {
  const changed = changedFilesSince(beforeSha);
  if (!changed.includes('package-lock.json')) {
    log('skipping npm install (lockfile unchanged)');
    return;
  }
  log('package-lock.json changed, running npm install');
  execFileSync('npm', ['install'], { cwd: REPO_HOME, stdio: 'inherit' });
}

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
 * Files release-please touches as a set on every release commit. Multi-file
 * merge conflicts in `nomad update` that consist entirely of paths from this
 * set are diagnostic for a release landing upstream while the mirror has its
 * own local commits on these artifacts. Taking upstream is the canonical
 * resolution (these are all generated artifacts the user has no business
 * editing on a mirror), but multi-file is more aggressive than the lone
 * lockfile case so we prompt before mutating.
 */
const RELEASE_PLEASE_ARTIFACTS: ReadonlySet<string> = new Set([
  'package.json',
  'package-lock.json',
  'CHANGELOG.md',
  '.release-please-manifest.json',
]);

/**
 * Resolve a merge conflict by taking upstream's version of every listed path,
 * regenerating the lockfile via `npm install`, and committing the merge.
 * Shared body for the lone-lockfile auto-resolve and the release-please
 * multi-file prompted auto-resolve.
 *
 * @param paths - Unmerged paths to resolve via `git checkout --theirs`.
 */
function resolveByTakingTheirs(paths: readonly string[]): void {
  for (const p of paths) {
    gitOrFatal(['checkout', '--theirs', '--', p], `git checkout --theirs ${p}`, REPO_HOME);
  }
  gitOrFatal(['add', ...paths], `git add ${paths.join(' ')}`, REPO_HOME);
  execFileSync('npm', ['install'], { cwd: REPO_HOME, stdio: 'inherit' });
  gitOrFatal(['add', 'package-lock.json'], 'git add package-lock.json', REPO_HOME);
  gitOrFatal(['commit', '--no-edit'], 'git commit --no-edit', REPO_HOME);
  log(`auto-resolved merge conflict (took upstream for ${paths.join(', ')}, reinstalled)`);
}

/**
 * Auto-resolve a merge conflict in the two scenarios both caused by
 * release-please landing upstream while the mirror has local commits:
 *
 * 1. **Sole `package-lock.json`** (silent): the lone-lockfile case from PR
 *    #96. Any host that has run `npm install` against the mirror will hit
 *    this on the next `nomad update`; take upstream + reinstall is the
 *    semantically-correct fix and surprise-free for a generated artifact.
 *
 * 2. **All paths in `RELEASE_PLEASE_ARTIFACTS` and more than one path**
 *    (prompted): a release commit conflicting on `package.json`,
 *    `CHANGELOG.md`, `.release-please-manifest.json` together with the
 *    lockfile. Same semantic resolution, but more files are touched so we
 *    require explicit y/N consent before mutating.
 *
 * Returns `false` for any other conflict shape (including probe failure);
 * the caller re-throws the original merge `NomadFatal` unchanged.
 *
 * @param opts - Update options; only `prompt` is consulted (used for the multi-file release-please consent prompt).
 * @returns `true` when the conflict was auto-resolved and the merge committed; `false` when the conflict shape does not match either auto-resolve case (caller should re-throw the original failure).
 */
function tryAutoResolveMergeConflict(opts: CmdUpdateOpts): boolean {
  let unmerged: string[];
  try {
    unmerged = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .split('\n')
      .filter((line) => line !== '');
  } catch {
    // Probe failure must not mask the original merge NomadFatal. Returning
    // false lets the caller re-throw the merge error unchanged.
    return false;
  }

  if (unmerged.length === 1 && unmerged[0] === 'package-lock.json') {
    resolveByTakingTheirs(['package-lock.json']);
    return true;
  }

  if (unmerged.length > 1 && unmerged.every((p) => RELEASE_PLEASE_ARTIFACTS.has(p))) {
    const promptFn = opts.prompt ?? defaultPrompt;
    log(`merge conflict in release-please artifacts: ${unmerged.join(', ')}`);
    const answer = promptFn(
      'Auto-resolve by taking upstream + `npm install` + commit? [y/N] ',
    ).toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      log('skipping auto-resolve (resolve manually then re-run `nomad update`)');
      return false;
    }
    resolveByTakingTheirs(unmerged);
    return true;
  }

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
