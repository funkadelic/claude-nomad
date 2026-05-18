/**
 * Reusable helpers for Phase 3 push-boundary safety: gitlink walker (D-05),
 * gitleaks presence probe (D-02), gitleaks staged scan (D-01, D-03), and
 * rebase-before-push (D-07, D-09, D-11).
 *
 * All three execFileSync-backed helpers use argv-array form with
 * `stdio: ['ignore', 'pipe', 'pipe']` (no shell). Same shape as
 * `gitStatusPorcelainZ` in src/utils.ts so the audit surface is uniform.
 *
 * Used by cmdPush (Plan 04) and cmdDoctor (Plan 05; the latter only consumes
 * `findGitlinks` and `probeGitleaks` as read-only diagnostics).
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

import { REPO_HOME } from './config.ts';
import { NomadFatal } from './utils.ts';

const GITLEAKS_INSTALL_HINT =
  'gitleaks not on PATH (required for nomad push). Install: brew install gitleaks (macOS) or download from https://github.com/gitleaks/gitleaks/releases (Linux/WSL).';

/**
 * Recursively find every entry whose basename is `.git` under `dir`. Returns
 * absolute paths. Used by cmdPush (D-05, refuse-on-hit) and cmdDoctor (D-15,
 * read-only diagnostic). Callers feed `REPO_HOME/shared/` only (D-06); the
 * tool's own repo .git at `~/claude-nomad/.git/` is outside the walk root.
 *
 * Does NOT follow symlinks. `Dirent.isDirectory()` returns `false` for
 * `S_IFLNK` entries even when the link target is a directory, so the
 * recursion naturally short-circuits at any symlink. This is the load-bearing
 * fix for RESEARCH Pitfall #1: an empirical test on Node 22.16 showed that
 * `readdirSync` in recursive mode followed a self-referential symlink cycle
 * to 82 entries at depth 83 before libuv's internal cap fired. The
 * hand-rolled walker below is cycle-safe by construction.
 *
 * Tolerates permission errors silently (returns whatever was collected before
 * the error). Reports both file gitlinks (submodule pointer) and directory
 * gitlinks (real nested repo) — both push as gitlinks and both break clone.
 */
export function findGitlinks(dir: string): string[] {
  const hits: string[] = [];
  function walk(current: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(current, e.name);
      if (e.name === '.git') hits.push(p);
      if (e.isDirectory()) walk(p);
    }
  }
  walk(dir);
  return hits;
}

/**
 * Probe for the gitleaks binary on PATH (D-02). Returns the trimmed `gitleaks
 * version` stdout on success. Throws NomadFatal with the install hint on
 * ENOENT; throws NomadFatal with the error message on any other failure.
 * Used by cmdPush (top-of-flow probe) and cmdDoctor (D-14 diagnostic).
 */
export function probeGitleaks(): string {
  try {
    return execFileSync('gitleaks', ['version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') throw new NomadFatal(GITLEAKS_INSTALL_HINT);
    throw new NomadFatal(`gitleaks --version failed: ${e.message}`);
  }
}

/**
 * Run gitleaks against the staged index (D-01). On non-zero exit (detection),
 * forwards gitleaks' own redacted stderr/stdout so the user sees which file
 * is dirty, then throws NomadFatal (D-03). Does NOT auto-rollback staging —
 * the user runs `git diff --cached` to identify the offending file.
 *
 * ENOENT branch is defense-in-depth: the D-02 probe at the top of cmdPush
 * should have caught a missing binary, but if cmdPush ever bypasses the
 * probe (or the user uninstalls gitleaks mid-flow) the same install-hint
 * FATAL fires here.
 */
export function runGitleaksScan(): void {
  // TODO(gitleaks v9): if "protect" is removed, migrate to "gitleaks git --pre-commit --staged".
  try {
    execFileSync('gitleaks', ['protect', '--staged', '--redact', '-v'], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      status?: number;
      stderr?: Buffer;
      stdout?: Buffer;
    };
    if (e.code === 'ENOENT') throw new NomadFatal(GITLEAKS_INSTALL_HINT);
    if (e.stderr) process.stderr.write(e.stderr);
    if (e.stdout) process.stdout.write(e.stdout);
    throw new NomadFatal(
      'gitleaks detected secrets; review staged changes with git diff --cached and unstage offending files before retry',
    );
  }
}

/**
 * Run `git pull --rebase --autostash` in REPO_HOME before push (D-07, D-11).
 * The `--autostash` absorbs dirty trees (in-progress path-map.json edits,
 * host overrides) so users do not need to commit-or-stash first.
 *
 * On failure, forwards git's stderr so the user sees the actual reason
 * (conflict, no-upstream, unreachable remote, auth failure, etc. — RESEARCH
 * Pitfall #3 option (a)), then throws NomadFatal.
 *
 * FATAL wording references `git rebase --continue` / `--abort` per the
 * RESEARCH Pitfall #2 correction. D-09 in CONTEXT.md originally suggested
 * pointing users at the stash list, but the autostash actually lives in
 * `.git/rebase-merge/autostash` mid-conflict and is reapplied by
 * `--continue` / `--abort` automatically. Pointing at the stash would
 * mislead the user; the corrected wording points at the actual recovery
 * commands.
 *
 * cmdPull (D-10) may adopt the same helper in a future refactor.
 */
export function rebaseBeforePush(): void {
  try {
    execFileSync('git', ['pull', '--rebase', '--autostash'], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    if (e.stderr) process.stderr.write(e.stderr);
    throw new NomadFatal(
      'rebase failed; if a conflict was reported, resolve it in ~/claude-nomad/ and run "git rebase --continue" (or "git rebase --abort" to give up). Re-run nomad push after resolution.',
    );
  }
}
