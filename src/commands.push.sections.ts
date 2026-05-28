/**
 * Pure section-builder helpers shared by `cmdPush` and `cmdPull` for the
 * doctor-style grouped tree. The builders are verb-agnostic: they take the
 * already-selected detail array (the wet `pushed`/`pulled` list or the dry-run
 * `wouldPush`/`wouldPull` list) plus the relevant skip count, so the same code
 * renders both push and pull rows. Row shapes mirror `nomad doctor`: one
 * `${green(okGlyph)} <item>` row per synced item, then a single collapsed
 * `${dim(infoGlyph)} <N> <noun>` count row instead of one row per skip.
 *
 * Sections returned here may be empty; `renderTree` (in `./output-tree.ts`)
 * skips empty sections, so a Sessions/Extras group with zero items and a zero
 * skip count never prints a header.
 */

import { dim, green, infoGlyph, okGlyph } from './color.ts';
import type { remapExtrasPush } from './extras-sync.ts';
import { type DoctorSection, addItem, renderTree, section } from './output-tree.ts';
import type { LeakVerdict } from './push-leak-verdict.ts';
import type { remapPush } from './remap.ts';
import { summaryRow } from './summary.ts';

/**
 * Build the single collapsed count row, or `null` when `n` is zero. Used for
 * the "not in path-map" session skips and the "extras skipped" extras skips so
 * the noisy per-project skip lines fold into one row that points at
 * `nomad doctor` for the authoritative list.
 *
 * @param n - The skip count (no row is produced when `0`).
 * @param noun - The collapsed-row phrasing after the count (e.g.
 *   `'not in path-map (run nomad doctor to list)'` or `'extras skipped'`).
 * @returns The rendered ℹ︎ count row, or `null` when `n` is `0`.
 */
export function collapsedSkipRow(n: number, noun: string): string | null {
  if (n <= 0) return null;
  return `${dim(infoGlyph)} ${n} ${noun}`;
}

/**
 * Build the Sessions section: one ✓ row per synced logical name plus, when
 * `unmapped > 0`, a single collapsed `${unmapped} not in path-map` count row.
 * Verb-agnostic: pass `remapResult.pushed` (or `wouldPush`, or the pull-side
 * `pulled`/`wouldPull`) as `items`.
 *
 * @param items - The logical names synced this run.
 * @param unmapped - Count of path-map entries skipped for this host.
 * @returns A `Sessions` `DoctorSection` (possibly empty).
 */
export function buildSessionsSection(items: string[], unmapped: number): DoctorSection {
  const s = section('Sessions');
  for (const logical of items) addItem(s, `${green(okGlyph)} ${logical}`);
  const skip = collapsedSkipRow(unmapped, 'not in path-map (run nomad doctor to list)');
  if (skip !== null) addItem(s, skip);
  return s;
}

/**
 * Build the Extras section: one ✓ row per synced `<logical>/<dirname>` entry
 * plus, when `extrasSkipped > 0`, a single collapsed `${extrasSkipped} extras
 * skipped` count row. Verb-agnostic: pass the wet or dry detail array as
 * `items`.
 *
 * @param items - The `<logical>/<dirname>` entries synced this run.
 * @param extrasSkipped - Count of dirnames the whitelist declined to sync.
 * @returns An `Extras` `DoctorSection` (possibly empty).
 */
export function buildExtrasSection(items: string[], extrasSkipped: number): DoctorSection {
  const s = section('Extras');
  for (const entry of items) addItem(s, `${green(okGlyph)} ${entry}`);
  const skip = collapsedSkipRow(extrasSkipped, 'extras skipped');
  if (skip !== null) addItem(s, skip);
  return s;
}

/**
 * Collected per-run push state threaded through `cmdPush` so the grouped tree
 * can be assembled once at the end. `remap`/`extras` carry the detail arrays +
 * counts; `dryRun` selects the wet (`pushed`) vs would-* (`wouldPush`) arrays.
 */
export type PushState = {
  dryRun: boolean;
  remap: ReturnType<typeof remapPush>;
  extras: ReturnType<typeof remapExtrasPush>;
};

/**
 * Assemble the Sessions/Extras sections shared by the real and dry-run push
 * paths, selecting the wet `pushed` detail arrays or the `wouldPush` arrays
 * under `dryRun`. The Leak scan and Summary sections are appended by the caller
 * in path-specific order.
 *
 * @param st - The collected push state.
 * @returns The ordered `[Sessions, Extras]` sections (either may be empty).
 */
function syncedSections(st: PushState): DoctorSection[] {
  const sessions = st.dryRun ? st.remap.wouldPush : st.remap.pushed;
  const extras = st.dryRun ? st.extras.wouldPush : st.extras.pushed;
  return [
    buildSessionsSection(sessions, st.remap.unmapped),
    buildExtrasSection(extras, st.extras.skipped),
  ];
}

/**
 * Build the single-row Summary section from the combined unmapped count
 * (sessions + extras), the collision count, and the extras-skipped count.
 * Phrasing is delegated to `summaryRow` so it matches `emitSummary` exactly.
 *
 * @param st - The collected push state.
 * @returns A `Summary` `DoctorSection` holding the one summary row.
 */
function summarySection(st: PushState): DoctorSection {
  const s = section('Summary');
  const unmapped = st.remap.unmapped + st.extras.unmapped;
  addItem(s, summaryRow('push', unmapped, st.remap.collisions, st.extras.skipped));
  return s;
}

/**
 * Render the grouped push tree with a Leak scan section (carrying `verdict`'s
 * row) between Extras and Summary. The caller throws the recovery body as a
 * `NomadFatal` AFTER this returns (real-push leak) or prints it via `fail`
 * (dry-run) so the recovery block follows the tree.
 *
 * @param st - The collected push state.
 * @param verdict - The leak verdict for the Leak scan section.
 */
export function renderPushTree(st: PushState, verdict: LeakVerdict): void {
  const leakScan = section('Leak scan');
  addItem(leakScan, verdict.verdictRow);
  renderTree([...syncedSections(st), leakScan, summarySection(st)]);
}

/**
 * Render the no-Leak-scan push tree (nothing-to-commit early return): the
 * Sessions/Extras rows (if any) plus the Summary row. `renderTree` skips empty
 * sections, so an empty push prints only the Summary.
 *
 * @param st - The collected push state.
 */
export function renderNoScanTree(st: PushState): void {
  renderTree([...syncedSections(st), summarySection(st)]);
}
