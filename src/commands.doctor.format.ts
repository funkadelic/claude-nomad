import { failGlyph, red } from './color.ts';
import { addItem, type DoctorSection } from './output-tree.ts';
import { readJson } from './utils.json.ts';

export { section, addItem, renderTree, renderDoctor, type DoctorSection } from './output-tree.ts';

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
