/**
 * Reusable helpers for push-boundary safety: gitlink walker, gitleaks
 * presence probe, gitleaks staged scan, and rebase-before-push.
 *
 * All execFileSync-backed helpers use argv-array form with
 * `stdio: ['ignore', 'pipe', 'pipe']` (no shell). Same shape as
 * `gitStatusPorcelainZ` in src/utils.ts so the audit surface is uniform.
 *
 * Used by `cmdPush` for refuse-on-hit safety and by `cmdDoctor` for
 * read-only diagnostics (doctor only consumes `findGitlinks` and
 * `probeGitleaks`).
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
 * absolute paths. Used by `cmdPush` (refuse-on-hit) and `cmdDoctor`
 * (read-only diagnostic). Callers feed `REPO_HOME/shared/` only; the tool's
 * own repo .git at `~/claude-nomad/.git/` is outside the walk root.
 *
 * Does NOT follow symlinks. `Dirent.isDirectory()` returns `false` for
 * `S_IFLNK` entries even when the link target is a directory, so the
 * recursion naturally short-circuits at any symlink. This is the
 * load-bearing fix for a known hazard: `readdirSync` in recursive mode
 * follows self-referential symlink cycles up to libuv's internal cap
 * (empirically verified on Node 22.16: 82 entries at depth 83 before the
 * cap fired). The hand-rolled walker below is cycle-safe by construction.
 *
 * Tolerates permission errors silently (returns whatever was collected before
 * the error). Reports both file gitlinks (submodule pointer) and directory
 * gitlinks (real nested repo); both push as gitlinks and both break clone.
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
      if (e.name === '.git') {
        hits.push(p);
        continue;
      }
      if (e.isDirectory()) walk(p);
    }
  }
  walk(dir);
  return hits;
}

/**
 * Probe for the gitleaks binary on PATH. Returns the trimmed `gitleaks
 * version` stdout on success. Throws NomadFatal with the install hint on
 * ENOENT; throws NomadFatal with the error message on any other failure.
 * Used by `cmdPush` (top-of-flow probe) and `cmdDoctor` (read-only).
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
 * Run gitleaks against the staged index. On non-zero exit (detection),
 * forwards gitleaks' own redacted stderr/stdout so the user sees which file
 * is dirty, then throws NomadFatal. Does NOT auto-rollback staging; the
 * user runs `git diff --cached` to identify the offending file.
 *
 * ENOENT branch is defense-in-depth: the presence probe at the top of
 * `cmdPush` should have caught a missing binary, but if `cmdPush` ever
 * bypasses the probe (or the user uninstalls gitleaks mid-flow) the same
 * install-hint FATAL fires here.
 */
export function runGitleaksScan(): void {
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
 * Run `git pull --rebase --autostash` in REPO_HOME before push.
 * The `--autostash` absorbs dirty trees (in-progress path-map.json edits,
 * host overrides) so users do not need to commit-or-stash first.
 *
 * On failure, forwards git's stderr so the user sees the actual reason
 * (conflict, no-upstream, unreachable remote, auth failure, etc.), then
 * throws NomadFatal.
 *
 * FATAL wording references `git rebase --continue` / `--abort` (not the
 * stash list): when `--autostash` is in flight, the stashed work lives in
 * `.git/rebase-merge/autostash` mid-conflict and is reapplied by
 * `--continue` / `--abort` automatically. Pointing the user at the stash
 * list would mislead them; the recovery commands are the actual fix.
 *
 * `cmdPull` may adopt the same helper in a future refactor.
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
