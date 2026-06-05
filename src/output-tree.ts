import { failGlyph, red } from './color.ts';

/**
 * Bare `failGlyph` codepoint (`✗`, U+2717) without any WSL padding the
 * `failGlyph` constant may carry. Header rendering composes its own
 * spacing (`${red(failGlyph)} ${header}`), so the section-header path
 * must use the unpadded codepoint to avoid a double space on WSL.
 */
const FAIL_GLYPH_BARE = '✗';

/**
 * Tree-style output builder shared by `cmdDoctor`, `cmdPush`, `cmdPull`, and
 * `computePreview` (dry-run / diff surface). Callers build an ordered list of
 * `DoctorSection`s, push pre-rendered plain-text items into the relevant
 * section, then call `renderTree` (aliased `renderDoctor` for doctor's call
 * site) to emit a Claude Code `/doctor`-style tree (`Header` / `  ├ item` /
 * `  └ last`) on stdout.
 *
 * Two rendering modes controlled by the optional `raw` flag on `DoctorSection`:
 *   - `raw: false` (default) renders the standard tree with `├`/`└` connectors
 *     and a `✗ ` fail-glyph prefix on the header when any item contains the
 *     fail glyph. Behavior is byte-identical to the prior implementation.
 *   - `raw: true` renders each item as `  ${item}` (two-space indent, no
 *     connector). The header prints verbatim with no fail-glyph prefix. Used
 *     by the settings.json diff block in the dry-run/diff preview.
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
  /** When `true`, items render as `  ${item}` with no tree connectors or glyph prefix. */
  raw?: boolean;
};

/**
 * Construct an empty section with the given header.
 *
 * @param header - section heading printed verbatim.
 * @param raw - when `true`, items render indented with no tree connectors.
 */
export function section(header: string, raw = false): DoctorSection {
  return { header, items: [], raw };
}

/** Append one rendered line to a section. */
export function addItem(s: DoctorSection, text: string): void {
  s.items.push(text);
}

/**
 * Append a nested child line to a section. Child items render one tree level
 * deeper than regular items, with their own `├`/`└` connectors under the
 * preceding regular item (see `renderSection`). Internally marked with a
 * leading tab, which no caller-supplied item text uses.
 */
export function addChildItem(s: DoctorSection, text: string): void {
  s.items.push(`\t${text}`);
}

/**
 * True when any item in the section contains the FAIL glyph.
 * Color-wrapped failGlyph (`[31m✗[39m`) still contains the
 * glyph as a substring, so this works for both color-on and color-off output.
 */
function sectionFailed(s: DoctorSection): boolean {
  return s.items.some((line) => line.includes(failGlyph));
}

/** Emit raw items: two-space indent, no connectors, no glyph prefix. */
function renderRawItems(items: string[]): void {
  for (const item of items) {
    console.log(item === '' ? '' : `  ${item}`);
  }
}

/**
 * Render one section: a (possibly fail-glyph-prefixed) header followed by its
 * items as a tree. Empty-string items print as true blank lines; the `└` elbow
 * attaches to the last non-empty item so a trailing blank cannot strand it.
 *
 * When `s.raw` is `true`, the header prints verbatim (no fail-glyph prefix)
 * and items render as `  ${item}` with no tree connectors.
 */
function renderSection(s: DoctorSection): void {
  if (s.raw) {
    console.log(s.header);
    renderRawItems(s.items);
    return;
  }
  const header = sectionFailed(s) ? `${red(FAIL_GLYPH_BARE)} ${s.header}` : s.header;
  console.log(header);
  // The `└` elbow attaches to the last non-empty REGULAR item; nested child
  // items get their own connectors one level deeper and never take the elbow.
  const lastContent = s.items.reduce(
    (acc, item, j) => (item === '' || isChild(item) ? acc : j),
    -1,
  );
  for (let j = 0; j < s.items.length; j++) {
    const item = s.items[j];
    if (item === '') console.log('');
    else if (isChild(item)) console.log(renderChildLine(s.items, j));
    else console.log(`${j === lastContent ? '  └ ' : '  ├ '}${item}`);
  }
}

/** True when the item was added via `addChildItem` (leading-tab marker). */
function isChild(item: string): boolean {
  return item.startsWith('\t');
}

/**
 * Render one nested child line: a deeper-indented `├`/`└` connector under the
 * preceding regular item. The gutter carries the parent stream's `│` while
 * regular items still follow below; once the parent stream has ended, plain
 * spaces.
 */
function renderChildLine(items: string[], j: number): string {
  const parentContinues = items.some((it, k) => k > j && it !== '' && !isChild(it));
  const gutter = parentContinues ? '  │ ' : '    ';
  const next = items[j + 1];
  const elbow = next === undefined || !isChild(next) ? '└ ' : '├ ';
  return `${gutter}  ${elbow}${items[j].slice(1)}`;
}

/**
 * Emit the full grouped tree. Skips empty sections, prefixes failed-section
 * headers with a red `✗ ` glyph (U+2717, same as the per-item FAIL glyph so
 * `grep -F '✗'` catches both row and header failures), and writes one blank
 * line between rendered sections (no leading or trailing blank).
 *
 * An empty-string item renders as a true blank line (no tree connector), which
 * lets a reporter set off a footer block (e.g. the `--check-shared` description
 * legend) with vertical whitespace. The `└` connector attaches to the last
 * non-empty item rather than the last array slot so a trailing blank does not
 * strand the elbow on an empty line.
 */
export function renderTree(sections: DoctorSection[]): void {
  const visible = sections.filter((s) => s.items.length > 0);
  for (let i = 0; i < visible.length; i++) {
    if (i > 0) console.log('');
    renderSection(visible[i]);
  }
}

/**
 * Back-compat alias for `renderTree`. Doctor's call site imports
 * `renderDoctor`; push/pull import `renderTree`. Both point at the same
 * implementation so doctor output stays byte-identical.
 */
export const renderDoctor = renderTree;
