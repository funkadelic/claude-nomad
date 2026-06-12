import { failGlyph, green, okGlyph, red, warnGlyph, yellow } from './color.ts';
import { addChildItem, addItem, section, type DoctorSection } from './commands.doctor.format.ts';

/**
 * Closing Summary section for `cmdDoctor`: a one-line verdict so the user can
 * stop reading after the last line, with every non-OK row repeated above it
 * so problems do not have to be hunted for in the body. Mirrors the
 * flutter doctor / brew doctor pattern. Pure presentation: counting is
 * substring-based on the same glyph constants the reporters emit, and this
 * module never touches `process.exitCode` (the reporters own that contract).
 */

/** True when the rendered line carries the FAIL glyph (color-safe substring test). */
function isFailLine(item: string): boolean {
  return item.includes(failGlyph);
}

/** True when the rendered line carries the WARN glyph (color-safe substring test). */
function isWarnLine(item: string): boolean {
  return !isFailLine(item) && item.includes(warnGlyph);
}

/**
 * Build the Summary section from every section rendered before it. The verdict
 * line leads as the section's single regular row, with each repeated WARN/FAIL
 * line hanging beneath it as a nested child (source child-marker stripped first
 * so a finding nested in its origin section still lands exactly one level under
 * the verdict, never two). The verdict carries NO status glyph (only severity
 * color) so the tally does not read as one more finding row; the nested rows
 * keep their glyphs, so the doubled glyph count for actual problems is
 * unchanged:
 *   - `N failure(s), M warning(s)` (red) when any FAIL line exists
 *   - `M warning(s)` (yellow) when only WARN lines exist
 *   - `✓ healthy` when neither (no children; cannot be mistaken for a finding)
 *
 * Renders as:
 *   Summary
 *     └ 1 warning(s)
 *         └ ⚠︎ backups: ...
 */
export function buildVerdictSection(sections: DoctorSection[]): DoctorSection {
  const summary = section('Summary');
  const lines = sections.flatMap((s) => s.items).map((item) => item.replace(/^\t/, ''));
  const failures = lines.filter(isFailLine);
  const warnings = lines.filter(isWarnLine);
  if (failures.length > 0) {
    addItem(summary, red(`${failures.length} failure(s), ${warnings.length} warning(s)`));
  } else if (warnings.length > 0) {
    addItem(summary, yellow(`${warnings.length} warning(s)`));
  } else {
    addItem(summary, `${green(okGlyph)} healthy`);
  }
  for (const line of [...failures, ...warnings]) addChildItem(summary, line);
  return summary;
}
