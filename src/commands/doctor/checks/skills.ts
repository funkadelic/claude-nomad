import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { dim, green, infoGlyph, okGlyph, warnGlyph, yellow } from '../../../render/color.ts';
import { addChildItem, addItem, type DoctorSection } from '../format.ts';
import { claudeHome, repoHome } from '../../../core/config.ts';
import { listDivergingFiles } from '../../../sync/extras/diff.ts';
import { isRootSkillExcluded } from '../../../sync/skills-sync.ts';

/**
 * Strip the side-indicator suffix appended by `listDivergingFiles`
 * (` (local only)` or ` (repo only)`) so that the first path component
 * can be tested for the gsd prefix independently of which side the file
 * is on.
 *
 * @param line - A labelled diff line from `listDivergingFiles`.
 * @returns The bare path with no side indicator.
 */
function stripSideIndicator(line: string): string {
  if (line.endsWith(' (local only)')) return line.slice(0, -' (local only)'.length);
  if (line.endsWith(' (repo only)')) return line.slice(0, -' (repo only)'.length);
  return line;
}

/**
 * Returns `true` when a `listDivergingFiles` output line refers to a
 * top-level name nomad never syncs (gsd-owned, denied, or Claude Code's
 * app-managed `synced/` folder), the same predicate push and pull use. The
 * diff lines carry full absolute paths (e.g.
 * `/home/user/.claude/skills/gsd-audit-fix/SKILL.md`), so the known base
 * path is stripped first; only the top-level component (immediately under
 * the skills directory) is tested. Checking every component would cause a
 * false positive when HOME or NOMAD_REPO contains a `gsd-`-prefixed segment.
 * A root-level denied name being filtered too is intended: push never
 * carries one, so it can never legitimately diverge.
 *
 * @param line - A labelled diff line from `listDivergingFiles`.
 * @param localBase - The absolute path of the local skills directory.
 * @param sharedBase - The absolute path of the shared skills directory.
 * @returns `true` if the top-level component is root-excluded.
 */
function isExcludedDiffLine(line: string, localBase: string, sharedBase: string): boolean {
  const bare = stripSideIndicator(line);
  let relative: string;
  if (bare.startsWith(localBase + '/')) {
    relative = bare.slice(localBase.length + 1);
  } else if (bare.startsWith(sharedBase + '/')) {
    relative = bare.slice(sharedBase.length + 1);
  } else {
    /* c8 ignore start -- diff lines from listDivergingFiles always start with one of the two base dirs */
    relative = bare;
    /* c8 ignore stop */
  }
  // relative is now "top-level-name/..." -- only that component matters.
  return isRootSkillExcluded(relative.split('/')[0]);
}

/**
 * Report divergence between `~/.claude/skills/` and `shared/skills/` into
 * the supplied doctor section. Top-level names nomad never syncs (gsd-owned,
 * denied, or Claude Code's `synced/` folder) are excluded from the check.
 * Emits a `dim(infoGlyph)` skip row when either directory is absent, a
 * `green(okGlyph)` row when the trees are identical, or a
 * `yellow(warnGlyph)` summary row plus one child item per diverging file
 * when differences exist. Never sets `process.exitCode`: divergence is a
 * nudge before a pull overwrites or a push carries a hand-edit, not a
 * hard failure.
 *
 * @param section - The `Skills` doctor section to populate.
 */
export function reportSkillsDivergence(section: DoctorSection): void {
  const sharedSkills = join(repoHome(), 'shared', 'skills');
  const localSkills = join(claudeHome(), 'skills');
  if (!existsSync(sharedSkills)) {
    addItem(section, `${dim(infoGlyph)} skills: no shared/skills/ to compare`);
    return;
  }
  if (!existsSync(localSkills)) {
    addItem(section, `${dim(infoGlyph)} skills: no local skills/ to compare`);
    return;
  }
  const diff = listDivergingFiles(localSkills, sharedSkills);
  const relevant = diff.filter((line) => !isExcludedDiffLine(line, localSkills, sharedSkills));
  if (relevant.length === 0) {
    addItem(section, `${green(okGlyph)} skills: in sync with shared/skills/`);
    return;
  }
  addItem(
    section,
    `${yellow(warnGlyph)} skills: ${relevant.length} file(s) diverge from shared/skills/`,
  );
  for (const f of relevant) {
    addChildItem(section, f);
  }
}
