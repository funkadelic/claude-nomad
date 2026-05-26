import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';

import type { CmdUpdateOpts } from './commands.update.ts';
import { REPO_HOME } from './config.ts';
import { gitOrFatal, log } from './utils.ts';

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
export function defaultPrompt(question: string): string {
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
export function resolveByTakingTheirs(paths: readonly string[]): void {
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
export function tryAutoResolveMergeConflict(opts: CmdUpdateOpts): boolean {
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
