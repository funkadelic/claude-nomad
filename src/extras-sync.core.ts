import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { HOST, REPO_HOME, SUPPORTED_EXTRAS, type PathMap } from './config.ts';
import { assertSafeLocalRoot, assertSafeLogical } from './extras-sync.guards.ts';
import { log } from './utils.ts';
import { readPathMap } from './utils.json.ts';

/** Parsed `path-map.json` plus its validated `extras` block. */
export type ValidatedExtras = { map: PathMap; extrasMap: Record<string, string[]> };

/** Skip counts: `unmapped` per-project (no host path / `'TBD'`), `skipped` per-dirname (not whitelisted). */
export type ExtrasCounts = { unmapped: number; skipped: number };

/**
 * Load and validate `path-map.json` for an extras op, owning the guard order
 * so the "FATAL before any filesystem mutation" contract holds for every
 * caller. Returns the parsed map plus its `extras` block, or `null` on a clean
 * early-exit (missing `path-map.json`, a missing repo extras dir when
 * `requireRepoExtras`, or an empty/absent `extras` key). THE VALIDATION PASS
 * runs here, up-front over the whole map (`assertSafeLogical` per logical,
 * `assertSafeLocalRoot` per mapped non-`'TBD'` path) so a clean entry ahead of
 * a poisoned one cannot let a `mkdirSync`/`cpSync` land before the FATAL fires.
 *
 * @param opts.requireRepoExtras - Also require `shared/extras/` (pull side).
 * @param opts.missingMsg - `log()` line on the missing-prereq exit (omitted for
 *   the divergence check, which skips silently).
 */
export function loadValidatedExtras(opts: {
  requireRepoExtras?: boolean;
  missingMsg?: string;
}): ValidatedExtras | null {
  const mapPath = join(REPO_HOME, 'path-map.json');
  const repoExtras = join(REPO_HOME, 'shared', 'extras');
  if (!existsSync(mapPath) || (opts.requireRepoExtras === true && !existsSync(repoExtras))) {
    if (opts.missingMsg !== undefined) log(opts.missingMsg);
    return null;
  }

  const map = readPathMap(mapPath);
  const extrasMap = map.extras ?? {};
  if (Object.keys(extrasMap).length === 0) return null;

  for (const logical of Object.keys(extrasMap)) {
    assertSafeLogical(logical);
    const localRoot = map.projects[logical]?.[HOST];
    if (localRoot && localRoot !== 'TBD') assertSafeLocalRoot(localRoot, logical);
  }
  return { map, extrasMap };
}

/**
 * Yield every surviving `{ logical, localRoot, dirname }` extras target after
 * the per-project and per-dirname skip filters, mutating `counts` as it goes
 * (`unmapped++` for a project with no host path / `'TBD'`, then skip it;
 * `skipped++` for a dirname outside `SUPPORTED_EXTRAS`). Shared by push, pull,
 * and the divergence check so all three walk identical skip/count semantics;
 * the caller builds src/dst from the yielded triple.
 *
 * @param v - validated path-map plus its extras block.
 * @param counts - mutated in place as targets are skipped or yielded.
 * @param quiet - Suppress the per-skip `log()` lines (push/pull and the
 *   read-only divergence check all pass `quiet=true`; the detail arrays or the
 *   collapsed count row carry the information instead). Counts increment
 *   either way.
 */
export function* eachExtrasTarget(
  v: ValidatedExtras,
  counts: ExtrasCounts,
  quiet = false,
): Generator<{ logical: string; localRoot: string; dirname: string }> {
  const whitelist: readonly string[] = SUPPORTED_EXTRAS;
  for (const [logical, dirnames] of Object.entries(v.extrasMap)) {
    const localRoot = v.map.projects[logical]?.[HOST];
    if (!localRoot || localRoot === 'TBD') {
      counts.unmapped++;
      if (!quiet) log(`skip ${logical}: no path for ${HOST}`);
      continue;
    }
    for (const dirname of dirnames) {
      if (!whitelist.includes(dirname)) {
        counts.skipped++;
        if (!quiet) log(`skip ${dirname} for ${logical}: not in SUPPORTED_EXTRAS`);
        continue;
      }
      yield { logical, localRoot, dirname };
    }
  }
}

/**
 * Recursive mirror copy: `rmSync` then `cpSync` so dst-only entries are
 * removed (true mirror, not just overwrite). Passes `verbatimSymlinks: true`
 * to keep relative symlink targets unrewritten across hosts (Pitfall 1;
 * nodejs/node issue 41693). Exported so the test file can call it directly;
 * `remapExtrasPush` and `remapExtrasPull` are the primary public API.
 */
export function copyExtras(src: string, dst: string): void {
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true, force: true, verbatimSymlinks: true });
}
