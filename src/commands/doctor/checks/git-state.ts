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
} from '../../../color.ts';
import { deniedSegmentFor, repoHome } from '../../../config.ts';
import { addItem, type DoctorSection } from '../format.ts';
import { classifyWedge, orphanedAutostashPresent } from '../../../commands.pull.wedge.ts';
import { gitProbe } from '../../../git-probe.ts';
import { findGitlinks } from '../../../push-checks.ts';
import { gitStatusPorcelainZ } from '../../../utils.ts';

/**
 * Git-state reporters for `cmdDoctor`: the gitleaks presence probe, the
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
      // Repo-relative paths are forward-slash on every platform (matches how
      // git itself reports paths); relative() returns a native (backslash on
      // win32) separator, so normalize before display.
      const rel = relative(repo, p).replaceAll('\\', '/');
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
 * FAILs (sets `process.exitCode = 1`) when `REPO_HOME` is wedged. Covers the
 * mid-rebase/mid-merge states plus the `'unmerged-index'` state (torn-down
 * rebase that left stage-2/3 entries in the index with no active rebase/merge
 * marker). All three wedge states hard-block every `nomad pull`/`nomad push`;
 * all three point at `nomad pull --force-remote` for auto-recovery. On a
 * clean repo, emits nothing.
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
 * its presence). Does NOT set `process.exitCode`.
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

/**
 * WARNs (non-blocking) when REPO_HOME has no resolvable committer identity for
 * user.name or user.email. Resolves identity the same way git does at commit
 * time: local repo config wins, else global, else unset. WARN not FAIL because
 * a pull-only host does not need a committer identity; the WARN catches the
 * fresh-clone case before nomad push hits a raw git error at commit time.
 *
 * Compact mode strips the PASS row automatically via the standard glyph test.
 */
export function reportGitIdentity(section: DoctorSection): void {
  const repo = repoHome();
  const missing: string[] = [];
  for (const field of ['user.name', 'user.email'] as const) {
    try {
      const val = execFileSync('git', ['config', field], {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .toString()
        .trim();
      if (!val) missing.push(field);
    } catch (err) {
      // git config exits 1 when the field is unset; other codes (128 = not a git
      // repo, ENOENT = cwd missing) are surfaced by reportRepoState; swallow here.
      if ((err as { status?: number }).status === 1) missing.push(field);
      else return;
    }
  }
  if (missing.length > 0) {
    const hint = missing.map((f) => `git config ${f} "..."`).join(' / ');
    addItem(
      section,
      `${yellow(warnGlyph)} git identity: ${missing.join(', ')} not set (run: ${hint})`,
    );
  } else {
    addItem(section, `${green(okGlyph)} git identity: user.name and user.email configured`);
  }
}

/**
 * Ceiling on the number of denylisted paths named individually. A committed
 * denied DIRECTORY expands to one row per file, and doctor's Summary repeats
 * every WARN line, so an uncapped listing buries the rest of the report. The
 * overflow count rides on the guidance row rather than a row of its own.
 */
const MAX_TRACKED_DENIED_ROWS = 5;

/**
 * C0 controls, DEL, and the C1 range, the characters a terminal acts on rather
 * than prints.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * Blank the control characters out of a path before it is rendered.
 *
 * A filename is repo-controlled, not nomad-controlled: it can arrive from
 * another host's push or from a repo cloned from anywhere, and `ls-files -z`
 * hands it over as raw bytes. An ESC in it would otherwise reach the terminal
 * as an escape sequence and could repaint or forge the rows around it, which on
 * a health report means forging its verdict.
 *
 * @param text Repo-controlled text bound for a doctor row.
 * @returns The same text with every control character replaced by a space.
 */
function renderable(text: string): string {
  return text.replace(CONTROL_CHARS, ' ');
}

/**
 * WARNs (non-blocking) for every denylisted path git TRACKS under `shared/`.
 *
 * The blind spot the pull-side backstop cannot cover. `revertDeniedMirrorPaths`
 * (`src/links.mirror.ts`) reads `git status`, which reports changes rather than
 * contents, so a denied path that is committed and clean produces no record at
 * all. That backstop is also win32-only, while the condition it would miss is a
 * property of the REPO, which every host shares. `git ls-files` reads the index
 * instead, so it sees the committed-and-clean case and a staged add alike.
 *
 * Report-only, and `process.exitCode` is left alone. Both halves of that are
 * deliberate: `reportTrackedDenied` owns the reasoning for why a tracked hit is
 * reported rather than acted on, and doctor's own convention keeps an advisory
 * off the exit code. Nothing here is a leak in flight, since the copy-time
 * filter in `mirrorOneSharedName` is what keeps such a path from being written,
 * and a path already committed is past the point where failing the run helps.
 *
 * `deniedSegmentFor` is the same predicate the push gate and the pull backstop
 * run through, so the three surfaces cannot disagree about what `shared/` may
 * carry, and it returns the matching segment so the WARN can name what blocked
 * the path. The row says "blocked by the never-sync boundary" rather than "is on
 * the never-sync list", because that predicate also matches on credential SHAPE
 * (`*.pem`, `.env*`, `id_rsa`), and a `deploy.key` is on no list the user could
 * go and read.
 *
 * The pathspec is `:(icase)shared/` rather than `shared/`. Git matches a
 * pathspec case-sensitively, so an index entry recorded as `Shared/` on a
 * case-insensitive filesystem would walk straight past a case-sensitive probe
 * while `deniedSegmentFor` would flag it, and a scan that silently narrows
 * itself is the failure shape this whole area is built to avoid.
 *
 * The guidance names `git rm --cached`, never a bare `git rm`. On posix
 * `shared/<name>` is the target of the `~/.claude/<name>` symlink, so the file a
 * bare `git rm` deletes is the user's live config, and a bare `git rm` fails
 * outright on a staged add, which is one of the two cases this check exists to
 * see. The row says what stays on disk for the same reason `reportTrackedDenied`
 * does: a gate whose entire output is one sentence cannot afford that sentence
 * to cost the user their file.
 *
 * A `null` probe (git absent, an unreadable repo, the timeout expiring, stdout
 * over the probe's ceiling) gets its own info row rather than a bare return.
 * Nothing else in doctor reports that git could not run here, so a silent skip
 * would leave "scanned, clean" and "never scanned" looking identical on exactly
 * the hosts with the most to sync.
 *
 * @param section The `DoctorSection` to append rows to.
 */
export function reportTrackedDeniedShared(section: DoctorSection): void {
  const out = gitProbe(['ls-files', '-z', '--', ':(icase)shared/'], repoHome());
  if (out === null) {
    addItem(
      section,
      `${dim(infoGlyph)} never-sync scan: git could not list shared/, so nothing was scanned`,
    );
    return;
  }
  const hits = new Map<string, string>();
  for (const path of out.split('\0')) {
    const segment = path === '' ? null : deniedSegmentFor(path);
    if (segment !== null) hits.set(path, segment);
  }
  if (hits.size === 0) {
    addItem(
      section,
      `${green(okGlyph)} never-sync scan: no tracked path under shared/ is denylisted`,
    );
    return;
  }
  for (const [path, segment] of [...hits].slice(0, MAX_TRACKED_DENIED_ROWS)) {
    addItem(
      section,
      `${yellow(warnGlyph)} never-sync: git tracks ${blue(renderable(path))} (the path segment "${renderable(segment)}" is blocked by the never-sync boundary)`,
    );
  }
  const overflow = hits.size - MAX_TRACKED_DENIED_ROWS;
  const more =
    overflow > 0
      ? `${overflow} more not listed, run git ls-files -- ":(icase)shared/" in the sync repo to see them all. `
      : '';
  addItem(
    section,
    `${yellow(warnGlyph)} never-sync: ${more}Run git rm --cached -- "<path>" and commit to stop tracking each one; that leaves the file on disk, so move it outside shared/ if you want to keep it. If one holds a real secret, rotate it and rewrite history too, because nomad only changes your local worktree and index and cannot scrub what a previous push already sent`,
  );
}
