import { failGlyph, warnGlyph } from './color.ts';
import { type DoctorSection } from './output-tree.ts';

/**
 * Section headers kept in full in the compact view. `Nomad Version` and
 * `Summary` are always-useful orientation; `Shared scan` / `Schema scan` only
 * carry items when their `--check-shared` / `--check-schema` flag ran, and when
 * present they must render in full even on a clean pass (the user explicitly
 * asked for that scan). Sections that never received items are dropped by
 * `renderTree` regardless, so listing the scan sections here is harmless when
 * their flag was not set.
 */
const ALWAYS_FULL = new Set(['Nomad Version', 'Summary', 'Shared scan', 'Schema scan']);

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
 * Collapse the full doctor section list to the compact default view: only what
 * needs action plus minimal orientation. Pure transform over the rendered
 * section objects, so reporters and the `process.exitCode` contract are
 * untouched (this never inspects or mutates exit state).
 *
 * - `ALWAYS_FULL` sections pass through unchanged.
 * - `Environment` keeps the repo-state row plus any WARN/FAIL rows.
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
      return { ...s, items: s.items.filter((it) => isRepoStateLine(it) || isProblem(it)) };
    }
    return { ...s, items: s.items.filter(isProblem) };
  });
}
