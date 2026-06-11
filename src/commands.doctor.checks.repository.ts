import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  blue,
  cyan,
  dim,
  failGlyph,
  green,
  infoGlyph,
  okGlyph,
  red,
  warnGlyph,
  yellow,
} from './color.ts';
import { repoHome } from './config.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { classifyWedge, orphanedAutostashPresent } from './commands.pull.wedge.ts';
import { findGitlinks } from './push-checks.ts';
import { gitStatusPorcelainZ } from './utils.ts';

/**
 * Repository-state reporters for `cmdDoctor`: the gitleaks presence probe, the
 * nested-gitlink scan of `shared/`, the remote-origin line, and the
 * rebase-clean-tree WARN. Each helper appends items to its target
 * `DoctorSection` and signals failure by setting `process.exitCode = 1`.
 * Read-only: FAIL lines stay on stdout.
 */

/**
 * Probes for gitleaks on PATH. Silent when found: the Dependency Versions
 * section already prints the version (with the CI-pin drift compare), so a
 * second OK row here was a duplicate. When gitleaks is absent (ENOENT), emits
 * warnGlyph and does NOT set exitCode: gitleaks is required for `nomad push`
 * but is an optional dependency for the read-only doctor check, so its absence
 * degrades to WARN per the project convention that optional-dependency absence
 * must never affect exit code. A non-ENOENT error (broken binary, permission
 * denied) still emits failGlyph and sets exitCode=1 because a
 * present-but-unrunnable gitleaks is a real defect that would break
 * `nomad push`. Returns `true` when a usable binary was found so the caller
 * can skip a redundant second `version` probe (e.g. the `--check-shared`
 * Shared scan section).
 */
export function reportGitleaksProbe(section: DoctorSection): boolean {
  try {
    execFileSync('gitleaks', ['version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      addItem(
        section,
        `${yellow(warnGlyph)} gitleaks: not on PATH (required for nomad push; install: https://github.com/gitleaks/gitleaks)`,
      );
    } else {
      addItem(section, `${red(failGlyph)} gitleaks: probe failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
    return false;
  }
}

/** Walks shared/ for nested .git gitlinks; emits failGlyph per gitlink found (sets exitCode=1), okGlyph when none. */
export function reportGitlinks(section: DoctorSection): void {
  const repo = repoHome();
  const sharedDir = join(repo, 'shared');
  if (existsSync(sharedDir)) {
    const gitlinks = findGitlinks(sharedDir);
    for (const p of gitlinks) {
      const rel = relative(repo, p);
      addItem(
        section,
        `${red(failGlyph)} gitlink: ${blue(rel)} would push as submodule (run: rm -rf ${rel} or remove the nested repo)`,
      );
    }
    if (gitlinks.length > 0) {
      process.exitCode = 1;
    } else {
      addItem(section, `${green(okGlyph)} gitlink scan: no nested .git in shared/`);
    }
  }
}

/** Pushes the `git remote get-url origin` line or a `not configured` informational line. */
export function reportRemote(section: DoctorSection): void {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoHome(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
    addItem(section, `${dim(infoGlyph)} remote origin: ${cyan(url)}`);
  } catch {
    addItem(section, `${dim(infoGlyph)} remote origin: not configured`);
  }
}

/** WARNs when ~/claude-nomad/ has uncommitted changes (autostash territory for push). */
export function reportRebaseClean(section: DoctorSection): void {
  try {
    const status = gitStatusPorcelainZ(repoHome());
    if (status.length > 0) {
      addItem(
        section,
        `${yellow(warnGlyph)} ${blue('~/claude-nomad/')} has uncommitted changes (nomad push will --autostash these)`,
      );
    }
  } catch {
    // gitStatusPorcelainZ failure on a missing or non-repo REPO_HOME is
    // already surfaced by reportHostAndPaths (warnGlyph on the `repo:` line
    // when the directory is absent) and reportRepoState ('empty' FAIL when
    // the scaffold is absent). Swallowing here avoids double-reporting.
  }
}

/**
 * FAILs (sets `process.exitCode = 1`) when `REPO_HOME` is wedged. Extends the
 * Phase 41 mid-rebase/mid-merge FAIL to cover the `'unmerged-index'` state
 * (torn-down rebase that left stage-2/3 entries in the index with no active
 * rebase/merge marker). All three wedge states hard-block every
 * `nomad pull`/`nomad push`; all three point at `nomad pull --force-remote`
 * for auto-recovery. On a clean repo, emits nothing (D-5).
 *
 * Uses `classifyWedge` (not `detectWedge`) so the unmerged-index state is
 * detected via the git exec probe, not just marker files.
 *
 * Wraps in try/catch and swallows errors so a missing or non-git `REPO_HOME`
 * does not double-report alongside the `reportRepoState` FAIL.
 */
export function reportRebaseState(section: DoctorSection): void {
  try {
    const wedge = classifyWedge(repoHome());
    if (wedge === null) return;
    if (wedge === 'unmerged-index') {
      addItem(
        section,
        `${red(failGlyph)} repo has an unmerged index with no active rebase: run 'nomad pull --force-remote' to auto-recover`,
      );
    } else {
      const state = wedge === 'rebase' ? 'mid-rebase' : 'mid-merge';
      addItem(
        section,
        `${red(failGlyph)} repo is ${state}: run 'nomad pull --force-remote' to auto-recover`,
      );
    }
    process.exitCode = 1;
    /* c8 ignore start */
  } catch {
    // classifyWedge failure on a missing or non-repo REPO_HOME is already
    // surfaced by reportRepoState. Swallowing avoids double-reporting.
  }
  /* c8 ignore stop */
}

/**
 * WARNs (non-blocking) when `REPO_HOME`'s stash list contains an orphaned
 * autostash entry. An orphaned autostash is non-blocking lost-work cruft
 * (the stash entry preserves the user's work; no git operation is blocked by
 * its presence). Does NOT set `process.exitCode` (per D-5).
 *
 * Mirrors `reportRebaseClean`'s WARN pattern. Runs separately from
 * `reportRebaseState` so both can fire in the same doctor run independently.
 *
 * @param sec The `DoctorSection` to append the WARN item to.
 */
export function reportOrphanedAutostash(sec: DoctorSection): void {
  try {
    if (orphanedAutostashPresent(repoHome())) {
      addItem(
        sec,
        `${yellow(warnGlyph)} repo has an orphaned autostash entry: run 'git stash pop' to restore or 'git stash drop' to discard`,
      );
    }
    /* c8 ignore start */
  } catch {
    // orphanedAutostashPresent failure on a missing or non-repo REPO_HOME is
    // already surfaced by reportRepoState. Swallowing avoids double-reporting.
  }
  /* c8 ignore stop */
}
