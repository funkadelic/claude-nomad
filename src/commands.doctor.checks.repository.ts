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
import { REPO_HOME } from './config.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { detectWedge } from './commands.pull.wedge.ts';
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
 * Probes for gitleaks on PATH. Emits okGlyph with version when found. When
 * gitleaks is absent (ENOENT), emits warnGlyph and does NOT set exitCode:
 * gitleaks is required for `nomad push` but is an optional dependency for the
 * read-only doctor check, so its absence degrades to WARN per the project
 * convention that optional-dependency absence must never affect exit code. A
 * non-ENOENT error (broken binary, permission denied) still emits failGlyph
 * and sets exitCode=1 because a present-but-unrunnable gitleaks is a real
 * defect that would break `nomad push`. Returns `true` when a usable binary
 * was found so the caller can skip a redundant second `version` probe (e.g.
 * the `--check-shared` Shared scan section).
 */
export function reportGitleaksProbe(section: DoctorSection): boolean {
  try {
    const v = execFileSync('gitleaks', ['version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim();
    addItem(section, `${green(okGlyph)} gitleaks: ${dim(v)}`);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      addItem(section, `${yellow(warnGlyph)} gitleaks: not on PATH (required for nomad push)`);
    } else {
      addItem(section, `${red(failGlyph)} gitleaks: probe failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
    return false;
  }
}

/** Walks shared/ for nested .git gitlinks; emits failGlyph per gitlink found (sets exitCode=1), okGlyph when none. */
export function reportGitlinks(section: DoctorSection): void {
  const sharedDir = join(REPO_HOME, 'shared');
  if (existsSync(sharedDir)) {
    const gitlinks = findGitlinks(sharedDir);
    for (const p of gitlinks) {
      const rel = relative(REPO_HOME, p);
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
      cwd: REPO_HOME,
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
    const status = gitStatusPorcelainZ(REPO_HOME);
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
 * FAILs (sets `process.exitCode = 1`) when `REPO_HOME` is wedged mid-rebase
 * or mid-merge. A wedged repo blocks every subsequent `nomad pull`; the FAIL
 * line points at `nomad pull --force-remote` for auto-recovery. On a clean
 * repo, emits nothing (no-news-good-news, matching `reportRebaseClean`).
 *
 * Wraps the `detectWedge` probe in try/catch and swallows errors so a
 * missing or non-git `REPO_HOME` does not double-report alongside the
 * `reportRepoState` FAIL that already surfaces that condition.
 */
export function reportRebaseState(section: DoctorSection): void {
  try {
    const wedge = detectWedge(REPO_HOME);
    if (wedge !== null) {
      const state = wedge === 'rebase' ? 'mid-rebase' : 'mid-merge';
      addItem(
        section,
        `${red(failGlyph)} repo is ${state}: run 'nomad pull --force-remote' to auto-recover`,
      );
      process.exitCode = 1;
    }
    /* c8 ignore start */
  } catch {
    // detectWedge failure on a missing or non-repo REPO_HOME is already
    // surfaced by reportRepoState. Swallowing avoids double-reporting.
  }
  /* c8 ignore stop */
}
