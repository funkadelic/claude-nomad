import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { claudeHome, repoHome } from './config.ts';
import { addItem, section, type DoctorSection } from './output-tree.ts';
import { isSkillExcluded } from './skills-sync.ts';

/**
 * Build the read-only `Skills` preview section shared by `pull --dry-run`,
 * `nomad diff`, and `sync --dry-run` (all three route through
 * `computePreview`). Resolves `shared/skills/` and `~/.claude/skills/` at
 * call time.
 *
 * When `shared/skills/` does not exist, returns the empty section
 * immediately; `renderTree` skips a section with zero items, so a repo with
 * no synced skills renders no `Skills` header at all (matching the existing
 * Extras section's no-`shared/extras/` behavior).
 *
 * Otherwise lists one glyph-free row per non-`gsd-*`/non-denied entry in
 * `shared/skills/` (what a wet pull would overlay), then, only when non-zero,
 * a single row naming how many local-only skills (present under
 * `~/.claude/skills/`, not `gsd-*`/denied, and absent from the shared
 * listing) would be retained. Wording deliberately mirrors the existing
 * Sessions local-only row so the two surfaces read the same.
 *
 * This section is filesystem-only and deliberately does NOT forecast an
 * upstream skill deletion (a root entry tracked at the host's last sync but
 * removed from `shared/skills/` since): `computePreview` is shared with the
 * offline `nomad diff`, which has no pre/post-rebase HEADs to compare
 * against. This mirrors the existing Extras preview, which likewise cannot
 * foresee a `.planning` upstream deletion ahead of time.
 *
 * Read-only contract: only `readdirSync`/`existsSync` are used here. No
 * `cpSync`/`rmSync`/`mkdirSync`, so `pull --dry-run`, `nomad diff`, and
 * `sync --dry-run` remain zero-mutation.
 *
 * @returns A `Skills` `DoctorSection` (possibly empty).
 */
export function buildSkillsPreviewSection(): DoctorSection {
  const s = section('Skills');
  const sharedSkills = join(repoHome(), 'shared', 'skills');
  if (!existsSync(sharedSkills)) return s;

  const sharedNames = readdirSync(sharedSkills, { encoding: 'utf8' }).filter(
    (name) => !isSkillExcluded(name),
  );
  for (const name of sharedNames) addItem(s, name);

  const localSkills = join(claudeHome(), 'skills');
  const localOnly = existsSync(localSkills)
    ? readdirSync(localSkills, { encoding: 'utf8' }).filter(
        (name) => !isSkillExcluded(name) && !sharedNames.includes(name),
      ).length
    : 0;
  if (localOnly > 0) {
    addItem(s, `${localOnly} local-only present, not in repo (push to reconcile)`);
  }

  return s;
}
