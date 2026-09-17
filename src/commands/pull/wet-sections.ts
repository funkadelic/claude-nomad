/**
 * The wet-pull grouped-tree section builder, extracted from `pull.ts` so the
 * command entry file stays focused on lock/lifecycle orchestration.
 */

import {
  buildExtrasSection,
  buildSessionsSection,
  buildSettingsSection,
} from '../push/sections.ts';
import { type PathMap } from '../../core/config.ts';
import { remapExtrasPull } from '../../sync/extras/extras.ts';
import { applySharedLinks, regenerateSettings } from '../../sync/links.ts';
import { writeSharedBaseline } from '../../sync/links.baseline.ts';
import { syncSkillsPull } from '../../sync/skills-sync.ts';
import { section, addItem, type DoctorSection } from '../../render/output-tree.ts';
import { remapPull, scanLocalOnly } from '../../sync/remap.ts';
import { withSpinner } from '../../render/spinner.ts';
import { summaryRow } from '../../render/summary.ts';
import { EXIT } from '../../core/exit-codes.ts';

/** The pull half's grouped-tree summary header; re-exported via `pull.ts` so `commands.sync.ts` can string-match it. */
export const PULL_SUMMARY_HEADER = 'Pull summary';

/**
 * Runs the WET pull side effects in order and builds, but does not render,
 * the `Settings`/`Sessions`/`Extras`/`Pull summary` sections. `prePostHeads`
 * lets extras/skills/settings delete an upstream-removed item instead of
 * refusing it; `namesDerived` only silences a duplicate `sharedDirs` WARN.
 */
export function buildWetPullSections(
  ts: string,
  map: PathMap,
  prePostHeads?: { pre: string; post: string },
  namesDerived = false,
): {
  sections: DoctorSection[];
  localOnly: number;
  settingsLabel: string;
  settingsBlocked: string[];
  unmapped: number;
  extrasSkipped: number;
} {
  applySharedLinks(ts, map, { quietNames: namesDerived });
  // Baseline write must follow a successful apply: it records what this host
  // now has, so a later run can tell a user delete apart from a never-synced
  // file. Always quiet: the apply call just above already reported this map.
  writeSharedBaseline(map, { quiet: true });
  const { label, blocked } = regenerateSettings(ts, { prePostHeads });
  // Non-fatal: sets the exit code but never throws, so the rest still runs.
  if (blocked.length > 0) {
    process.exitCode = EXIT.SETTINGS_BLOCKED;
  }
  syncSkillsPull(ts, prePostHeads);
  const remapResult = withSpinner('Syncing sessions', () => remapPull(ts));
  const extrasResult = remapExtrasPull(ts, { prePostHeads });
  // Retain-merge never changes the local-only set, so counting after the
  // copy matches counting before it.
  const localOnly = scanLocalOnly();
  const unmapped = remapResult.unmapped + extrasResult.unmapped;
  const summary = section(PULL_SUMMARY_HEADER);
  addItem(summary, summaryRow('pull', unmapped, 0, extrasResult.skipped, localOnly));
  return {
    sections: [
      buildSettingsSection(label, blocked),
      buildSessionsSection(remapResult.pulled, remapResult.unmapped, localOnly),
      buildExtrasSection(extrasResult.pulled, extrasResult.skipped),
      summary,
    ],
    localOnly,
    settingsLabel: label,
    settingsBlocked: blocked,
    unmapped,
    extrasSkipped: extrasResult.skipped,
  };
}
