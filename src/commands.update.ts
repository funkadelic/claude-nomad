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

/** Read `git rev-parse --abbrev-ref HEAD` from REPO_HOME, trimmed. Wraps
 * the failure path so a corrupt or missing `.git` directory surfaces as
 * `[nomad] FATAL: ...` via the dispatcher's `NomadFatal` catch rather than
 * a raw `ExecException` stack trace. */
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
 * Default y/N prompt used when `opts.prompt` is not injected. Reads from
 * `/dev/tty` byte-by-byte until newline so the call returns after the user
 * presses Enter (cooked-mode TTY line buffering). The naive `readFileSync(0)`
 * approach reads until EOF, which hangs interactive use until Ctrl-D. Opens
 * `/dev/tty` directly so the prompt still works when stdin is piped or
 * redirected. Any failure (no controlling TTY, read error) returns `''`,
 * which `runFork` treats as "no" and skips the push.
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

/** Read the current `HEAD` SHA in REPO_HOME, trimmed. Used to pin the
 * pre-update commit so the post-update diff is exact regardless of whether
 * the pull was a fast-forward, a no-op, or a merge. `HEAD@{1}` is unreliable
 * here: no-op `git pull --ff-only` does not always write a reflog entry, and
 * a freshly cloned repo has no `HEAD@{1}` at all. Failures route through
 * `NomadFatal` so the dispatcher prints `[nomad] FATAL: ...` rather than a
 * raw stack trace. */
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
 * Names of files changed between `beforeSha` and the current `HEAD`. Empty
 * when the update was a no-op (same SHA).
 */
function changedFilesSince(beforeSha: string): string[] {
  const out = execFileSync('git', ['diff', '--name-only', `${beforeSha}..HEAD`], {
    cwd: REPO_HOME,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  return out.split('\n').filter((line) => line !== '');
}

/**
 * Run `npm install` in `REPO_HOME` only when `package-lock.json` shifted
 * between `beforeSha` and the current HEAD; otherwise log a skip line.
 * Routing through `execFileSync` (no shell) keeps the call mockable in tests
 * and prevents any chance of argv injection.
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
 * Vanilla topology update: a single fast-forward pull from origin/main.
 * Non-ff pulls (someone else pushed) surface as NomadFatal via gitOrFatal.
 * Takes the full opts so the signature stays symmetric with `runFork` even
 * though only `dryRun` is consulted today.
 */
function runVanilla(opts: CmdUpdateOpts): void {
  if (opts.dryRun === true) {
    log('DRY-RUN: would run `git pull --ff-only origin main`');
    return;
  }
  gitOrFatal(['pull', '--ff-only', 'origin', 'main'], 'git pull', REPO_HOME);
}

/**
 * Fork topology update: fetch upstream, merge upstream/main, optionally push
 * the result to origin. The prompt step is gated by `pushOrigin` (no prompt
 * when explicit) and by `dryRun` (no prompt, no push when previewing).
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
 * Topology-aware "pull the latest upstream and reinstall if needed" command.
 * Detects vanilla (`origin` -> public) vs fork (`upstream` -> public,
 * `origin` -> private mirror) layouts, runs the right git invocation, runs
 * `npm install` only when `package-lock.json` changed in the update, and
 * ends with `cmdDoctor()` so the version-check PASS line confirms the
 * upgrade landed.
 *
 * Prompts (fork topology, no `--push-origin`) read a single synchronous line
 * from fd 0; tests inject `opts.prompt` to bypass the TTY read.
 *
 * Pre-flight (each fatal unless overridden):
 *   1. REPO_HOME exists.
 *   2. Topology resolves to vanilla or fork.
 *   3. Current branch is `main`.
 *   4. Working tree clean per `gitStatusPorcelainZ` (override with `force`).
 *
 * Dry-run (`opts.dryRun`) runs pre-flight + logs the would-be git commands
 * and returns without mutating the repo or invoking `cmdDoctor`.
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
