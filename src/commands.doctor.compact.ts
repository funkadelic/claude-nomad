import { failGlyph, warnGlyph } from './color.ts';
import { type DoctorSection } from './output-tree.ts';

/**
 * Section headers kept in full in the compact view. `Nomad Version` and
 * `Summary` are always-useful orientation; `Shared scan` / `Schema scan` /
 * `Remote check` only carry items when their `--check-shared` /
 * `--check-schema` / `--check-remote` flag ran, and when present they must
 * render in full even on a clean pass (the user explicitly asked for that
 * scan). Sections that never received items are dropped by `renderTree`
 * regardless, so listing the scan sections here is harmless when their flag
 * was not set.
 */
const ALWAYS_FULL = new Set([
  'Nomad Version',
  'Summary',
  'Shared scan',
  'Schema scan',
  'Remote check',
]);

/**
 * True when the rendered line carries a WARN or FAIL glyph. Substring test on
 * the same glyph constants the reporters emit, color-safe (a color-wrapped
 * glyph still contains the codepoint as a substring), mirroring `verdict.ts`.
 */
function isProblem(item: string): boolean {
  return item.includes(failGlyph) || item.includes(warnGlyph);
}

/**
 * True for the Environment repo-state row, kept in the compact view as orienting
 * context alongside the Nomad Version. Matches the stable `repo state:` label
 * emitted by `reportRepoState`.
 */
function isRepoStateLine(item: string): boolean {
  return item.includes('repo state:');
}

/**
 * True for the Environment sync-modality row on native Windows only. Copy-sync
 * is the one modality where the host-side file and the repo-side file are
 * distinct, so the row is worth surfacing without `--verbose` on that platform.
 * On posix the symlink modality is the unsurprising default, so that row stays
 * verbose-only and the compact view is unchanged there. Matches the stable
 * `sync modality:` label emitted by `reportSyncModality`.
 */
function isWin32ModalityLine(item: string): boolean {
  return process.platform === 'win32' && item.includes('sync modality:');
}

/**
 * Collapse the full doctor section list to the compact default view: only what
 * needs action plus minimal orientation. Pure transform over the rendered
 * section objects, so reporters and the `process.exitCode` contract are
 * untouched (this never inspects or mutates exit state).
 *
 * - `ALWAYS_FULL` sections pass through unchanged.
 * - `Environment` keeps the repo-state row, the sync-modality row on win32
 *   (see `isWin32ModalityLine`), plus any WARN/FAIL rows.
 * - every other section keeps only its WARN/FAIL rows; an emptied section is
 *   skipped by `renderTree` (it renders no zero-item sections).
 *
 * @param sections - the full ordered section list (body sections + Summary).
 * @returns a new list; input sections are not mutated.
 */
export function compactSections(sections: DoctorSection[]): DoctorSection[] {
  return sections.map((s) => {
    if (ALWAYS_FULL.has(s.header)) return s;
    if (s.header === 'Environment') {
      return {
        ...s,
        items: s.items.filter(
          (it) => isRepoStateLine(it) || isWin32ModalityLine(it) || isProblem(it),
        ),
      };
    }
    return { ...s, items: s.items.filter(isProblem) };
  });
}
