import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';

import { cmdDoctor } from './commands.doctor.ts';
import { REPO_HOME } from './config.ts';
import { loadTopology } from './update.topology.ts';
import { die, gitOrFatal, gitStatusPorcelainZ, log, NomadFatal } from './utils.ts';

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
 * `[nomad] FATAL: ...` via the top-level dispatcher's `NomadFatal` catch
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
 */
function runVanilla(opts: CmdUpdateOpts): void {
  if (opts.dryRun === true) {
    log('DRY-RUN: would run `git pull --ff-only origin main`');
    return;
  }
  gitOrFatal(['pull', '--ff-only', 'origin', 'main'], 'git pull', REPO_HOME);
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
 * @param opts - Update options; respected fields are:
 *   - `dryRun`: when true, log actions instead of executing them
 *   - `pushOrigin`: when true, push to `origin/main` without prompting
 *   - `prompt`: optional prompt function used for interactive confirmation
 */
function runFork(opts: CmdUpdateOpts): void {
  const promptFn = opts.prompt ?? defaultPrompt;
  if (opts.dryRun === true) {
    log('DRY-RUN: would run `git fetch upstream`');
    log('DRY-RUN: would run `git merge upstream/main`');
    if (opts.pushOrigin === true) {
      log('DRY-RUN: would run `git push origin main`');
    } else {
      log('DRY-RUN: would prompt before pushing to origin/main');
    }
    return;
  }
  gitOrFatal(['fetch', 'upstream'], 'git fetch upstream', REPO_HOME);
  gitOrFatal(['merge', 'upstream/main'], 'git merge upstream/main', REPO_HOME);
  if (opts.pushOrigin === true) {
    gitOrFatal(['push', 'origin', 'main'], 'git push origin main', REPO_HOME);
    return;
  }
  const answer = promptFn('[nomad] push merge to origin/main? [y/N] ').toLowerCase();
  if (answer === 'y' || answer === 'yes') {
    gitOrFatal(['push', 'origin', 'main'], 'git push origin main', REPO_HOME);
  } else {
    log('skipping push to origin (run `git push origin main` later)');
  }
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
    log('WARN working tree is not clean, proceeding because --force was passed');
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
  if (topology === 'vanilla') runVanilla(opts);
  else runFork(opts);

  reinstallIfNeeded(beforeSha);
  cmdDoctor();
}
