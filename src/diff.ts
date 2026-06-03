import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { BACKUP_BASE, REPO_HOME, type PathMap } from './config.ts';
import { computePreview } from './preview.ts';
import { die, fail, NomadFatal } from './utils.ts';
import { freshBackupTs } from './utils.fs.ts';
import { readPathMap } from './utils.json.ts';

/**
 * `nomad diff` command. Offline-safe, read-only preview surface that runs
 * the same `computePreview` orchestration as `pull --dry-run` but WITHOUT
 * acquiring the pull/push lockfile and WITHOUT running `git pull --rebase`.
 *
 * Intent: answer "what would be applied from local repo state right now"
 * (offline-safe). For "what will the next real pull do" (with the network
 * round-trip), use `pull --dry-run` instead.
 *
 * Does NOT create the per-run backup directory under
 * `~/.cache/claude-nomad/backup/<ts>/`: cmdDiff writes nothing, and an empty
 * dir would pollute the cache. The `ts` value is still computed for log
 * lines (so the preview output is consistent with `pull --dry-run`).
 *
 * Errors:
 *   - REPO_HOME missing surfaces as the canonical `repo not cloned at <path>`
 *     FATAL, matching cmdPull / cmdPush.
 *   - computePreview is tolerant of partial scaffold; cmdDiff inherits the
 *     same tolerance.
 *   - Any NomadFatal escapes into the local catch which writes the FATAL
 *     line to stderr and sets `process.exitCode = 1`. Non-NomadFatal errors
 *     rethrow.
 */
export function cmdDiff(): void {
  try {
    if (!existsSync(REPO_HOME)) die(`repo not cloned at ${REPO_HOME}`);
    const ts = freshBackupTs(BACKUP_BASE);
    // Preview log lines reference `ts` so output stays consistent with
    // pull --dry-run; the backup root itself is intentionally NOT created.
    // Read the map tolerantly (offline-safe: fall back to no-sharedDirs when
    // path-map.json is absent from a partially-scaffolded repo).
    const mapPath = join(REPO_HOME, 'path-map.json');
    const map: PathMap = existsSync(mapPath) ? readPathMap(mapPath) : { projects: {} };
    // computePreview renders the full tree including the Summary row; no
    // separate emitSummary call needed (it would print a duplicate).
    computePreview(ts, map, 'diff');
  } catch (err) {
    if (err instanceof NomadFatal) {
      fail(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
