import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { type PathMap } from './config.ts';
import { readJson } from './utils.ts';

/**
 * Read-only health classifier for `cmdDoctor`'s `repo state:` header.
 * Inspects three signals at the given `repoHome`: `shared/settings.base.json`
 * presence, `path-map.json.projects` having at least one entry, and
 * `hosts/<host>.json` presence.
 *
 * Returns `'empty'` when the base is missing AND the path-map has no entries
 * (either missing or `projects` is empty); `'populated'` when all three
 * signals are positive; `'partial'` for anything in between. Malformed
 * `path-map.json` is treated as zero entries rather than thrown, so a doctor
 * run against a corrupted scaffold still produces a classification line.
 *
 * The `host` parameter is passed explicitly (rather than read from the
 * imported `HOST` constant) so the test fixture can drive multiple host
 * scenarios without mutating module-level state via `vi.resetModules()`.
 */
export function classifyRepoState(
  repoHome: string,
  host: string,
): 'empty' | 'partial' | 'populated' {
  const basePath = join(repoHome, 'shared', 'settings.base.json');
  const mapPath = join(repoHome, 'path-map.json');
  const hostPath = join(repoHome, 'hosts', `${host}.json`);

  const hasBase = existsSync(basePath);
  const hasMap = existsSync(mapPath);
  const hasHost = existsSync(hostPath);

  let mapEntryCount = 0;
  if (hasMap) {
    try {
      const map = readJson<PathMap>(mapPath);
      mapEntryCount = Object.keys(map.projects).length;
    } catch {
      // Malformed JSON: treat as zero entries, do NOT throw. The doctor's
      // own JSON-parse FAIL line will surface the malformed file separately.
      mapEntryCount = 0;
    }
  }

  if (!hasBase && mapEntryCount === 0) return 'empty';
  if (hasBase && mapEntryCount > 0 && hasHost) return 'populated';
  return 'partial';
}

/**
 * Suffix that follows `repo state: WARN partial` per the fixed priority
 * order. First matching condition wins, exactly one suffix per line.
 * Inspects the same on-disk signals `classifyRepoState` reads (base file,
 * `path-map.json` + its `.projects` entry count, `hosts/<host>.json`), but
 * explicitly distinguishes "path-map missing" from "path-map present but
 * empty" because users debug differently for each.
 *
 * Lives alongside `classifyRepoState` so the suffix rules and the classifier
 * stay co-located: changes to one almost always require updating the other.
 * Returns the string with a leading `- ` separator so the caller can
 * concatenate directly without re-deciding the separator.
 */
export function reasonForPartial(repoHome: string, host: string): string {
  const basePath = join(repoHome, 'shared', 'settings.base.json');
  const mapPath = join(repoHome, 'path-map.json');
  const hostPath = join(repoHome, 'hosts', `${host}.json`);
  if (!existsSync(basePath)) return '- shared/settings.base.json missing';
  if (!existsSync(mapPath)) return '- path-map.json missing';
  let mapEntryCount: number;
  try {
    const map = readJson<PathMap>(mapPath);
    mapEntryCount = Object.keys(map.projects).length;
  } catch {
    // Malformed JSON: treat as zero entries. Doctor's own JSON-parse FAIL
    // line surfaces the malformed file separately.
    mapEntryCount = 0;
  }
  if (mapEntryCount === 0) return '- path-map.json.projects has no entries';
  if (!existsSync(hostPath)) return `- hosts/${host}.json missing`;
  // Defensive fallback: classifyRepoState returned 'partial' for a reason
  // not captured by the four signals above. Should be unreachable in
  // practice because the priority order is exhaustive against the
  // classifier's definition of populated.
  return '- partial state (unknown gap)';
}
