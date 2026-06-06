/**
 * Push dry-run gitleaks leak preview.
 *
 * Stages a read-only copy of the session transcripts and extras that a real
 * `nomad push` would send for this host, then runs `scanStagedTree` against
 * that temp tree. The verdict is RETURNED as a structured
 * `{ leak, verdictRow, recovery }` (rather than logged) so `cmdPush` can place
 * `verdictRow` in the grouped tree's Leak scan section and print `recovery`
 * (the `buildSessionAwareFatal` body) below the tree. On findings it still sets
 * `process.exitCode = 1`.
 *
 * This module is the push-dry-run-only path. The `nomad doctor --check-shared`
 * preflight (session-only scan, no extras) is unchanged and lives in
 * `./commands.doctor.check-shared.ts`. Extras-in-doctor is a deferred
 * follow-up (out of scope here).
 */

import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { dim, infoGlyph } from './color.ts';
import { claudeHome, repoHome, HOST, SUPPORTED_EXTRAS, type PathMap } from './config.ts';
import { assertSafeLogical } from './config.sharedDirs.guard.ts';
import { copyExtras } from './extras-sync.ts';
import { copyDirJsonlOnly } from './remap.ts';
import { type LeakVerdict, verdictFromFindings, verdictScanError } from './push-leak-verdict.ts';
import { scanStagedTree } from './push-gitleaks.ts';
import { nowTimestamp } from './utils.fs.ts';
import { encodePath } from './utils.json.ts';

/** Rendered neutral Leak scan row when there was nothing to scan. */
const NOTHING_TO_SCAN_ROW = `${dim(infoGlyph)} nothing to scan, no leaks`;

/**
 * Stage local session transcripts for HOST into `<tmpRoot>/shared/projects/<logical>/`
 * using the same depth-0 `*.jsonl` filter as a real push. Builds the
 * encoded-dir-to-logical reverse map from `map.projects` (skipping TBD or
 * missing entries), then copies each matching `~/.claude/projects/<dir>/`.
 *
 * @param tmpRoot - Root of the throwaway staging tree.
 * @param map - Parsed `path-map.json`.
 * @returns Number of session directories staged.
 */
function stageSessions(tmpRoot: string, map: PathMap): number {
  if (typeof map.projects !== 'object' || map.projects === null) return 0;

  const reverse = new Map<string, string>();
  for (const [logical, hosts] of Object.entries(map.projects)) {
    assertSafeLogical(logical);
    const p = hosts[HOST];
    if (!p || p === 'TBD') continue;
    reverse.set(encodePath(p), logical);
  }

  const localProjects = join(claudeHome(), 'projects');
  if (!existsSync(localProjects)) return 0;

  let staged = 0;
  for (const dir of readdirSync(localProjects)) {
    const logical = reverse.get(dir);
    if (!logical) continue;
    copyDirJsonlOnly(join(localProjects, dir), join(tmpRoot, 'shared', 'projects', logical));
    staged++;
  }
  return staged;
}

/**
 * Stage whitelisted extras for HOST into
 * `<tmpRoot>/shared/extras/<logical>/<dirname>/`. Mirrors the skip semantics of
 * `remapExtrasPush`: skips logicals with no host path or `'TBD'`, skips
 * dirnames not in `SUPPORTED_EXTRAS`, and skips when the source path does not
 * exist locally.
 *
 * Guards a non-object or missing `map.projects` defensively (mirroring
 * `stageSessions`): a malformed map with an `extras` block but no usable
 * `projects` stages nothing rather than throwing on the `map.projects[logical]`
 * read.
 *
 * @param tmpRoot - Root of the throwaway staging tree.
 * @param map - Parsed `path-map.json`.
 * @returns Number of extras entries staged.
 */
function stageExtras(tmpRoot: string, map: PathMap): number {
  if (typeof map.projects !== 'object' || map.projects === null) return 0;
  const extrasMap = map.extras ?? {};
  const whitelist: readonly string[] = SUPPORTED_EXTRAS;
  let staged = 0;
  for (const [logical, dirnames] of Object.entries(extrasMap)) {
    assertSafeLogical(logical);
    const localRoot = map.projects[logical]?.[HOST];
    if (!localRoot || localRoot === 'TBD') continue;
    for (const dirname of dirnames) {
      if (!whitelist.includes(dirname)) continue;
      const src = join(localRoot, dirname);
      if (!existsSync(src)) continue;
      const dst = join(tmpRoot, 'shared', 'extras', logical, dirname);
      copyExtras(src, dst);
      staged++;
    }
  }
  return staged;
}

/**
 * Run a read-only gitleaks leak preview of what `nomad push` would stage for
 * this host: both mapped session transcripts
 * (`shared/projects/<logical>/*.jsonl`) and opted-in extras
 * (`shared/extras/<logical>/<dirname>`).
 *
 * Stages the content into a throwaway tree under
 * `~/.cache/claude-nomad/push-preview-tree-<stamp>` and runs `scanStagedTree`
 * with `forwardStreams=false` (read-only: no gitleaks stderr/stdout leak to the
 * terminal). The temp tree is always removed in a `finally`, regardless of
 * whether the scan found leaks, crashed, or returned clean. `REPO_HOME/shared`
 * is never written.
 *
 * Returns a structured `LeakVerdict` rather than logging the verdict line so
 * `cmdPush` can render `verdictRow` in the Leak scan section and print
 * `recovery` below the tree. Side effects preserved: `process.exitCode = 1` on
 * findings AND on a scan crash. A scan that throws maps to a ✗ scan-error row
 * with `exitCode = 1`: ENOENT (gitleaks/git absent) keeps the "not on PATH"
 * wording, any other error (e.g. EACCES) surfaces its real message so the
 * cause is not mislabeled. Nothing-to-scan maps to a neutral ℹ︎ row.
 *
 * Fails closed before any copy: an unsafe `logical` key (path separator or
 * `..`) raised by `assertSafeLogical` in the staging step propagates out as a
 * `NomadFatal` to `cmdPush`, and the `finally` still removes the temp tree.
 *
 * @param map - Parsed `path-map.json` (already in scope from `cmdPush`).
 * @returns The structured verdict for the Leak scan section.
 */
export function previewPushLeaks(map: PathMap): LeakVerdict {
  const cacheDir = join(homedir(), '.cache', 'claude-nomad');
  mkdirSync(cacheDir, { recursive: true });
  const stamp = `${nowTimestamp()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  const tmpRoot = join(cacheDir, `push-preview-tree-${stamp}`);

  try {
    const sessionCount = stageSessions(tmpRoot, map);
    const extrasCount = stageExtras(tmpRoot, map);
    if (sessionCount + extrasCount === 0) {
      return { leak: false, verdictRow: NOTHING_TO_SCAN_ROW, recovery: null, findings: [] };
    }
    const ignoreFile = join(repoHome(), '.gitleaksignore');
    if (existsSync(ignoreFile)) {
      copyFileSync(ignoreFile, join(tmpRoot, '.gitleaksignore'));
    }
    let findings: ReturnType<typeof scanStagedTree>;
    try {
      findings = scanStagedTree(tmpRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return verdictScanError('scan error (git or gitleaks not on PATH)');
      }
      return verdictScanError(`scan error: ${(err as Error).message}`);
    }
    return verdictFromFindings(findings);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
