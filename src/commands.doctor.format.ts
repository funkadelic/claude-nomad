import { failGlyph, red } from './color.ts';
import { readJson } from './utils.json.ts';

/**
 * Bare `failGlyph` codepoint (`✗`, U+2717) without any WSL padding the
 * `failGlyph` constant may carry. Header rendering composes its own
 * spacing (`${red(failGlyph)} ${header}`), so the section-header path
 * must use the unpadded codepoint to avoid a double space on WSL.
 */
const FAIL_GLYPH_BARE = '✗';

/**
 * Tree-style output builder for `cmdDoctor`. Doctor builds an ordered list of
 * `DoctorSection`s, each reporter pushes plain-text items into the relevant
 * section, then the orchestrator calls `renderDoctor` to emit a Claude Code
 * `/doctor`-style tree (`Header` / `  ├ item` / `  └ last`) on stdout.
 *
 * Color and status glyphs (okGlyph/warnGlyph/failGlyph/infoGlyph) already
 * live inside the item text; this module never re-colors or re-tokenizes.
 * Sections with zero items are skipped at render time (no empty headers).
 *
 * Output goes directly through `console.log` rather than `utils.log` so the
 * dim `ℹ︎` info glyph used by `pull` / `push` / `init` does NOT appear in
 * doctor output (doctor has its own glyphs per row). Test assertions continue
 * to spy on `console.log`.
 */
export type DoctorSection = {
  header: string;
  items: string[];
};

/** Construct an empty section with the given header. */
export function section(header: string): DoctorSection {
  return { header, items: [] };
}

/** Append one rendered line to a section. */
export function addItem(s: DoctorSection, text: string): void {
  s.items.push(text);
}

/**
 * Tolerant JSON reader for `cmdDoctor`. Doctor reads three JSON files
 * (`settings.json`, `settings.base.json`, `path-map.json`); a malformed
 * input must not throw mid-output (user would lose every line below it).
 * Returns `null` on parse failure, records a FAIL item in the supplied
 * section, and sets `process.exitCode = 1` so scripts can gate on the result.
 */
export function readJsonSafe<T>(path: string, label: string, section: DoctorSection): T | null {
  try {
    return readJson<T>(path);
  } catch (err) {
    addItem(section, `${red(failGlyph)} ${label} malformed JSON: ${(err as Error).message}`);
    process.exitCode = 1;
    return null;
  }
}

/**
 * True when any item in the section contains the FAIL glyph.
 * Color-wrapped failGlyph (`[31m✗[39m`) still contains the
 * glyph as a substring, so this works for both color-on and color-off output.
 */
function sectionFailed(s: DoctorSection): boolean {
  return s.items.some((line) => line.includes(failGlyph));
}

/**
 * Emit the full doctor report. Skips empty sections, prefixes failed-section
 * headers with a red `✗ ` glyph (U+2717, same as the per-item FAIL glyph so
 * `grep -F '✗'` catches both row and header failures), and writes one blank
 * line between rendered sections (no leading or trailing blank).
 */
export function renderDoctor(sections: DoctorSection[]): void {
  const visible = sections.filter((s) => s.items.length > 0);
  for (let i = 0; i < visible.length; i++) {
    if (i > 0) console.log('');
    const s = visible[i];
    const header = sectionFailed(s) ? `${red(FAIL_GLYPH_BARE)} ${s.header}` : s.header;
    console.log(header);
    for (let j = 0; j < s.items.length; j++) {
      const isLast = j === s.items.length - 1;
      console.log(`${isLast ? '  └ ' : '  ├ '}${s.items[j]}`);
    }
  }
}
