import { failGlyph, green, okGlyph, red, warnGlyph, yellow } from './color.ts';
import { addItem, section, type DoctorSection } from './commands.doctor.format.ts';

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
 * Build the Summary section from every section rendered before it. Repeats
 * each WARN/FAIL line verbatim (child-marker stripped so repeated lines render
 * flat), then closes with the verdict line:
 *   - `✗ N failure(s), M warning(s)` when any FAIL line exists
 *   - `⚠︎ M warning(s)` when only WARN lines exist
 *   - `✓ healthy` when neither
 */
export function buildVerdictSection(sections: DoctorSection[]): DoctorSection {
  const summary = section('Summary');
  const lines = sections.flatMap((s) => s.items).map((item) => item.replace(/^\t/, ''));
  const failures = lines.filter(isFailLine);
  const warnings = lines.filter(isWarnLine);
  for (const line of [...failures, ...warnings]) addItem(summary, line);
  if (failures.length > 0) {
    addItem(
      summary,
      `${red(failGlyph)} ${failures.length} failure(s), ${warnings.length} warning(s)`,
    );
  } else if (warnings.length > 0) {
    addItem(summary, `${yellow(warnGlyph)} ${warnings.length} warning(s)`);
  } else {
    addItem(summary, `${green(okGlyph)} healthy`);
  }
  return summary;
}
