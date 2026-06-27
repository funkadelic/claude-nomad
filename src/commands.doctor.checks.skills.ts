import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { dim, green, infoGlyph, okGlyph, warnGlyph, yellow } from './color.ts';
import { addChildItem, addItem, type DoctorSection } from './commands.doctor.format.ts';
import { claudeHome, GSD_PREFIX, repoHome } from './config.ts';
import { listDivergingFiles } from './extras-sync.diff.ts';

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
 * gsd-prefixed skill. Gsd-owned skills are excluded from copy-sync and
 * are expected to appear only locally, so they must be filtered out of
 * the divergence report. The diff lines carry full absolute paths (e.g.
 * `/home/user/.claude/skills/gsd-audit-fix/SKILL.md`), so the known base
 * path is stripped first; only the skill-name component (immediately under
 * the skills directory) is tested. Checking every component would cause a
 * false positive when HOME or NOMAD_REPO contains a `gsd-`-prefixed segment.
 *
 * @param line - A labelled diff line from `listDivergingFiles`.
 * @param localBase - The absolute path of the local skills directory.
 * @param sharedBase - The absolute path of the shared skills directory.
 * @returns `true` if the skill-name component starts with the gsd prefix.
 */
function isGsdDiffLine(line: string, localBase: string, sharedBase: string): boolean {
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
  // relative is now "skill-name/..." -- only the skill-name component matters.
  return relative.split('/')[0].startsWith(GSD_PREFIX);
}

/**
 * Report divergence between `~/.claude/skills/` and `shared/skills/` into
 * the supplied doctor section. Gsd-prefixed skills are excluded from the
 * check (they are excluded from copy-sync and expected to be local-only).
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
  const relevant = diff.filter((line) => !isGsdDiffLine(line, localSkills, sharedSkills));
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
