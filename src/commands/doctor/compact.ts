import { failGlyph, warnGlyph } from '../../color.ts';
import { isChild, type DoctorSection } from '../../output-tree.ts';

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
 * True for the copy-sync variant of the Environment sync-modality row. Copy-sync
 * is the one modality where the host-side file and the repo-side file are
 * distinct, so the row is worth surfacing without `--verbose`. The posix symlink
 * variant is the unsurprising default, so it stays verbose-only and the compact
 * view is unchanged there.
 *
 * Matches on the emitted CONTENT rather than re-reading `process.platform`, so
 * this stays a pure function of its argument: `reportSyncModality` only emits
 * the copy-sync wording on win32, which makes the platform check redundant, and
 * a platform read here would quietly break `compactSections`'s pure-transform
 * contract.
 */
function isCopySyncModalityLine(item: string): boolean {
  return item.includes('sync modality: copy-sync');
}

/**
 * The Environment keep-rule: the repo-state row, the copy-sync modality row,
 * and anything carrying a WARN or FAIL glyph.
 */
function isKeptEnvironmentRow(item: string): boolean {
  return isRepoStateLine(item) || isCopySyncModalityLine(item) || isProblem(item);
}

/**
 * Filter a section's items by `keep`, carrying each retained row's nested child
 * rows along with it. Child rows (see `addChildItem`) carry no status glyph, so
 * testing them against `keep` would drop every one of them and leave a WARN row
 * stating a count with nothing to name it: `reportSkillsDivergence` and the
 * win32 shared-copy drift check both render "N file(s) diverge" as the parent
 * and the filenames as children. A child under a dropped row is dropped with
 * it, so a surviving child can never re-attach its connector to an unrelated
 * preceding row in `renderChildLine`.
 */
function keepWithChildren(items: string[], keep: (item: string) => boolean): string[] {
  const out: string[] = [];
  let parentKept = false;
  for (const item of items) {
    if (isChild(item)) {
      if (parentKept) out.push(item);
      continue;
    }
    parentKept = keep(item);
    if (parentKept) out.push(item);
  }
  return out;
}

/**
 * Collapse the full doctor section list to the compact default view: only what
 * needs action plus minimal orientation. Pure transform over the rendered
 * section objects, so reporters and the `process.exitCode` contract are
 * untouched (this never inspects or mutates exit state).
 *
 * - `ALWAYS_FULL` sections pass through unchanged.
 * - `Environment` keeps the repo-state row, the copy-sync modality row
 *   (see `isCopySyncModalityLine`), plus any WARN/FAIL rows.
 * - every other section keeps only its WARN/FAIL rows; an emptied section is
 *   skipped by `renderTree` (it renders no zero-item sections).
 * - a retained row keeps its nested child rows (see `keepWithChildren`), so a
 *   count and the names behind it stay together.
 *
 * @param sections - the full ordered section list (body sections + Summary).
 * @returns a new list; input sections are not mutated.
 */
export function compactSections(sections: DoctorSection[]): DoctorSection[] {
  return sections.map((s) => {
    if (ALWAYS_FULL.has(s.header)) return s;
    const keep = s.header === 'Environment' ? isKeptEnvironmentRow : isProblem;
    return { ...s, items: keepWithChildren(s.items, keep) };
  });
}
