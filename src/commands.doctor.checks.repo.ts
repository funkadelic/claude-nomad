import { existsSync, lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
import { CLAUDE_HOME, HOST, REPO_HOME, SHARED_LINKS } from './config.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { classifyRepoState, reasonForPartial } from './init.classify.ts';

/**
 * Host- and repo-state reporters for `cmdDoctor`. Each helper appends one or
 * more items to its target `DoctorSection` (via `addItem`) and signals failure
 * by setting `process.exitCode = 1`. Items go to stdout at render time through
 * `renderDoctor` in `commands.doctor.format`; nothing here writes to stderr
 * (read-only doctor contract: FAIL lines stay on stdout so a piped
 * `nomad doctor 2>/dev/null` does not lose them).
 */

/**
 * True when the `NOMAD_REPO` env override is set to a non-empty value.
 * Mirrors the `||` empty-string-fallthrough semantics of `REPO_HOME` itself
 * (see `src/config.ts`): an unset env, or `export NOMAD_REPO=`, both return
 * false because the default fallback fires. Reads `process.env.NOMAD_REPO`
 * directly so a set-but-empty value is distinguishable from "set to the
 * default path"; reading via the imported `REPO_HOME` constant cannot make
 * that distinction. Exposed for `reportRepoState`; not for general use.
 */
export function isOverrideActive(): boolean {
  return Boolean(process.env.NOMAD_REPO);
}

/**
 * Pushes the host identity (info) and the two key path lines (repo and
 * claude-home) with gutter glyphs. Path presence is reported via warnGlyph
 * (not failGlyph) so an absent CLAUDE_HOME does not flip sectionFailed to
 * decorate the Host header with `✘`. The authoritative empty-repo FAIL is
 * owned by reportRepoState; these two lines remain informational and do
 * NOT mutate process.exitCode.
 */
export function reportHostAndPaths(section: DoctorSection): void {
  addItem(section, `${dim(infoGlyph)} host: ${cyan(HOST)}`);
  addItem(
    section,
    `${existsSync(REPO_HOME) ? green(okGlyph) : yellow(warnGlyph)} repo: ${blue(REPO_HOME)}`,
  );
  addItem(
    section,
    `${existsSync(CLAUDE_HOME) ? green(okGlyph) : yellow(warnGlyph)} claude home: ${blue(CLAUDE_HOME)}`,
  );
}

/** Emits the repo-state status line derived from classifyRepoState (okGlyph/warnGlyph/failGlyph). When `NOMAD_REPO` is active, all three branches receive a ` (NOMAD_REPO)` suffix so the env override is visible whatever the repo state. FAIL signals via process.exitCode. */
export function reportRepoState(section: DoctorSection): void {
  const state = classifyRepoState(REPO_HOME, HOST);
  // Computed once so populated/partial/empty branches share the same
  // annotation. Leading space before `(` keeps the line readable on every
  // branch; empty string produces zero visual change when the override is
  // not in play, matching SPEC §5 (acceptance: unset env -> no annotation).
  const overrideLabel = isOverrideActive() ? ' (NOMAD_REPO)' : '';
  if (state === 'populated') {
    addItem(section, `${green(okGlyph)} repo state: populated${overrideLabel}`);
  } else if (state === 'partial') {
    addItem(
      section,
      `${yellow(warnGlyph)} repo state: partial ${reasonForPartial(REPO_HOME, HOST)}${overrideLabel}`,
    );
  } else {
    addItem(
      section,
      `${red(failGlyph)} repo state: empty - run 'nomad init' to scaffold${overrideLabel}`,
    );
    process.exitCode = 1;
  }
}

/**
 * Resolve the display item and optional exit-code side-effect for a single
 * shared-link path. Returns `{ line, fail }` where `fail` true means the
 * caller should set `process.exitCode = 1`.
 *
 * Extracted from `reportSharedLinks` to reduce cognitive complexity: the lstat
 * try/catch and the inner symlink-target try/catch each count against the
 * parent function's score.
 */
function classifySharedLink(name: string, p: string): { line: string; fail: boolean } {
  let stat;
  try {
    stat = lstatSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { line: `${yellow(warnGlyph)} ${name}: missing`, fail: false };
    }
    return { line: `${red(failGlyph)} ${name}: could not stat (${String(code)})`, fail: true };
  }
  if (!stat.isSymbolicLink()) {
    return { line: `${red(failGlyph)} ${name}: NOT a symlink (blocks sync)`, fail: true };
  }
  return classifySymlinkTarget(name, p);
}

/**
 * Resolve the display item for a path already confirmed to be a symlink.
 * Follows the link via statSync; a throw means the target is missing or
 * unreadable. Returns `{ line, fail: false }` (symlink issues are WARN, not FAIL).
 */
function classifySymlinkTarget(name: string, p: string): { line: string; fail: boolean } {
  try {
    statSync(p);
    return { line: `${green(okGlyph)} ${name}: symlink`, fail: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        line: `${yellow(warnGlyph)} ${name}: broken symlink (target missing)`,
        fail: false,
      };
    }
    return {
      line: `${yellow(warnGlyph)} ${name}: symlink target unreadable (${String(code)})`,
      fail: false,
    };
  }
}

/**
 * Emits a per-entry status line for each name in SHARED_LINKS
 * (okGlyph/warnGlyph/failGlyph). A non-symlink blocks sync and FAILs via
 * process.exitCode. TOCTOU-safe: lstatSync is wrapped in try/catch so a path
 * that vanishes or becomes unreadable between the probe and the stat yields a
 * row instead of an unhandled throw that aborts the whole doctor run. A symlink
 * whose target cannot be resolved is a WARN (broken-symlink for a missing
 * target, target-unreadable otherwise), never a healthy OK, so a dangling or
 * unreadable link is not masked.
 */
export function reportSharedLinks(section: DoctorSection): void {
  for (const name of SHARED_LINKS) {
    const p = join(CLAUDE_HOME, name);
    const { line, fail } = classifySharedLink(name, p);
    addItem(section, line);
    if (fail) process.exitCode = 1;
  }
}
