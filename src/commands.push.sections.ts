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
import type { GlobalConfigChange } from './push-global-config.ts';
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
function collapsedSkipRow(n: number, noun: string): string | null {
  if (n <= 0) return null;
  return `${dim(infoGlyph)} ${n} ${noun}`;
}

/**
 * Build the Settings section for `cmdPull`: a single
 * `${green(okGlyph)} settings.json (base + <label>)` row. `label` is the
 * override-source tag returned by `regenerateSettings` (`'<HOST>.json'` when a
 * host override exists, else `'no host overrides'`), surfacing what was written
 * without `regenerateSettings` logging the line inline. Push has no Settings
 * section, so this helper is pull-only.
 *
 * @param label - The override-source tag from `regenerateSettings`.
 * @returns A `Settings` `DoctorSection` holding the one settings row.
 */
export function buildSettingsSection(label: string): DoctorSection {
  const s = section('Settings');
  addItem(s, `${green(okGlyph)} settings.json (base + ${label})`);
  return s;
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
 * Build the Global config section: one `${green(okGlyph)} <label> <path>` row
 * per changed shared-config file. An empty `rows` array produces a zero-item
 * section, which `renderTree` skips (matching the Sessions/Extras empty
 * handling), so no "Global config" header prints when nothing changed.
 *
 * @param rows - Shared-config changes collected by `collectGlobalConfigChanges`.
 * @returns A `Global config` `DoctorSection` (possibly empty).
 */
export function buildGlobalConfigSection(rows: GlobalConfigChange[]): DoctorSection {
  const s = section('Global config');
  for (const row of rows) {
    addItem(s, `${green(okGlyph)} ${row.label} ${row.path}`);
  }
  return s;
}

/**
 * Collected per-run push state threaded through `cmdPush` so the grouped tree
 * can be assembled once at the end. `remap`/`extras` carry the detail arrays +
 * counts; `dryRun` selects the wet (`pushed`) vs would-* (`wouldPush`) arrays.
 * `globalConfig` carries the shared-config changes for the "Global config" section.
 */
export type PushState = {
  dryRun: boolean;
  remap: ReturnType<typeof remapPush>;
  extras: ReturnType<typeof remapExtrasPush>;
  globalConfig: GlobalConfigChange[];
};

/**
 * Assemble the Global config / Sessions / Extras sections shared by the real
 * and dry-run push paths. Global config leads (empty sections are dropped by
 * `renderTree`); Sessions and Extras follow, selecting the wet `pushed` detail
 * arrays or the `wouldPush` arrays under `dryRun`. The Leak scan and Summary
 * sections are appended by the caller in path-specific order.
 *
 * @param st - The collected push state.
 * @returns The ordered `[Global config, Sessions, Extras]` sections (any may be empty).
 */
function syncedSections(st: PushState): DoctorSection[] {
  const sessions = st.dryRun ? st.remap.wouldPush : st.remap.pushed;
  const extras = st.dryRun ? st.extras.wouldPush : st.extras.pushed;
  return [
    buildGlobalConfigSection(st.globalConfig),
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
 * Render the no-Leak-scan push tree: the Sessions/Extras rows (if any) plus the
 * Summary row. `renderTree` skips empty sections, so an empty push prints only
 * the Summary. Two callers: the real-push nothing-to-commit early return
 * (`noMapHint` omitted) and the dry-run no-`path-map.json` case
 * (`noMapHint: true`), which prepends a `Path map` section carrying a single
 * `${dim(infoGlyph)} no path-map.json (nothing to preview)` row so a dry-run
 * user sees WHY no Leak scan section rendered (no map means nothing to stage).
 *
 * @param st - The collected push state.
 * @param opts.noMapHint - When `true`, prepend the no-path-map hint section.
 * @returns Nothing; renders to stdout.
 */
export function renderNoScanTree(st: PushState, opts: { noMapHint?: boolean } = {}): void {
  const sections: DoctorSection[] = [];
  if (opts.noMapHint === true) {
    const pathMap = section('Path map');
    addItem(pathMap, `${dim(infoGlyph)} no path-map.json (nothing to preview)`);
    sections.push(pathMap);
  }
  renderTree([...sections, ...syncedSections(st), summarySection(st)]);
}
