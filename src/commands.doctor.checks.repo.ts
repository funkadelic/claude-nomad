import { existsSync, lstatSync } from 'node:fs';
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

/** Emits a per-entry status line for each name in SHARED_LINKS (okGlyph/warnGlyph/failGlyph). A non-symlink blocks sync and FAILs via process.exitCode. */
export function reportSharedLinks(section: DoctorSection): void {
  for (const name of SHARED_LINKS) {
    const p = join(CLAUDE_HOME, name);
    if (!existsSync(p)) {
      addItem(section, `${yellow(warnGlyph)} ${name}: missing`);
      continue;
    }
    if (lstatSync(p).isSymbolicLink()) {
      addItem(section, `${green(okGlyph)} ${name}: symlink`);
    } else {
      addItem(section, `${red(failGlyph)} ${name}: NOT a symlink (blocks sync)`);
      process.exitCode = 1;
    }
  }
}
