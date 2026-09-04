/**
 * Push dry-run gitleaks leak preview.
 *
 * Stages a read-only copy of the session transcripts and extras that a real
 * `nomad push` would send for this host, then runs `scanStagedTree` against
 * that temp tree. The verdict is RETURNED as a structured
 * `{ leak, verdictRow, recovery }` (rather than logged) so `cmdPush` can place
 * `verdictRow` in the grouped tree's Leak scan section and print `recovery`
 * (the `buildSessionAwareFatal` body) below the tree. On findings it sets
 * `process.exitCode = EXIT.LEAK_BLOCKED` (5, matching a real push); a scan that
 * ran but produced no parseable report also fails closed to `5` (matching the
 * real push); only a scan that threw before any report (gitleaks/git absent)
 * sets `1` (see `verdictFromFindings`/`verdictScanError`).
 *
 * This module is the push-dry-run-only path. The `nomad doctor --check-shared`
 * preflight (session-only scan, no extras) is unchanged and lives in
 * `./commands.doctor.check-shared.ts`. Extras-in-doctor is a deferred
 * follow-up (out of scope here).
 */

import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { dim, infoGlyph } from '../../color.ts';
import { claudeHome, repoHome, HOST, SUPPORTED_EXTRAS, type PathMap } from '../../config.ts';
import { assertSafeLogical } from '../../config.sharedDirs.guard.ts';
import { copyExtras } from '../../extras-sync.ts';
import { type ManifestDiff } from './manifest.ts';
import { copyDirJsonlOnly, copyFileAtomic } from '../../remap.ts';
import { type LeakVerdict, verdictFromFindings, verdictScanError } from './leak-verdict.ts';
import { scanStagedTree } from './gitleaks.ts';
import { copySkillsPush, isSkillExcluded } from '../../skills-sync.ts';
import { nowTimestamp } from '../../utils.fs.ts';
import { encodePath } from '../../utils.json.ts';

/** Rendered neutral Leak scan row when there was nothing to scan. */
const NOTHING_TO_SCAN_ROW = `${dim(infoGlyph)} nothing to scan, no leaks`;

/**
 * Copy one project directory into the staging tree. When `changed` is defined,
 * only the files present in that set and rooted under `localDir` are copied via
 * `copyFileAtomic`; dirs with no matching files return `false` (skipped). When
 * `changed` is `undefined` (cold start), falls back to `copyDirJsonlOnly`
 * (full mirror). Returns `true` when at least one file was staged.
 *
 * @param localDir - Absolute path to `~/.claude/projects/<encoded>/`.
 * @param dstDir - Absolute path to `<tmpRoot>/shared/projects/<logical>/`.
 * @param changed - Selected changed source paths, or `undefined` for full copy.
 * @returns `true` when files were staged, `false` when the dir was skipped.
 */
function stageSessionDir(
  localDir: string,
  dstDir: string,
  changed: Set<string> | undefined,
): boolean {
  if (changed !== undefined) {
    const prefix = `${localDir}${sep}`;
    const matching = [...changed].filter((p) => p.startsWith(prefix));
    if (matching.length === 0) return false;
    for (const src of matching) {
      copyFileAtomic(src, join(dstDir, relative(localDir, src)));
    }
    return true;
  }
  copyDirJsonlOnly(localDir, dstDir);
  return true;
}

/**
 * Stage local session transcripts for HOST into `<tmpRoot>/shared/projects/<logical>/`
 * using the same depth-0 `*.jsonl` filter as a real push. Builds the
 * encoded-dir-to-logical reverse map from `map.projects` (skipping TBD or
 * missing entries), then copies each matching `~/.claude/projects/<dir>/`.
 *
 * When `changed` is provided only source files in that set are staged (one
 * `copyFileAtomic` per file); dirs with no matching files are skipped entirely
 * so their inode and mtime in the repo tree are not disturbed.
 *
 * @param tmpRoot - Root of the throwaway staging tree.
 * @param map - Parsed `path-map.json`.
 * @param changed - Optional set of changed source paths from `ManifestDiff`.
 * @returns Number of session directories staged.
 */
function stageSessions(tmpRoot: string, map: PathMap, changed?: Set<string>): number {
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
    const localDir = join(localProjects, dir);
    const dstDir = join(tmpRoot, 'shared', 'projects', logical);
    if (stageSessionDir(localDir, dstDir, changed)) staged++;
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
 * Stage non-gsd user skills for the preview scan into
 * `<tmpRoot>/shared/skills/<name>/...`, mirroring `syncSkillsPush`'s copy: the
 * same symlink guard (a symlinked `~/.claude/skills` is the symlink-era live
 * link, skipped) and the same `copySkillsPush` filter (gsd-owned names and
 * `ALWAYS_NEVER_SYNC` denylist excluded at every depth). Writes only into the
 * throwaway `tmpRoot`, never `REPO_HOME/shared`.
 *
 * The returned count is the number of top-level user-skill names that will be
 * copied (`isSkillExcluded` false), used only for the nothing-to-scan gate. It
 * is a lower bound on real coverage, never a false zero: any name it counts is
 * definitely copied by `copySkillsPush`, whose block set is a subset of the
 * exclusion `isSkillExcluded` applies.
 *
 * @param tmpRoot - Root of the throwaway staging tree.
 * @returns Number of top-level user skills staged.
 */
function stageSkills(tmpRoot: string): number {
  const localSkills = join(claudeHome(), 'skills');
  const stat = lstatSync(localSkills, { throwIfNoEntry: false });
  // Symlink-era host (skills not yet copy-migrated): the preview stages nothing,
  // so it does not re-scan any skill content already committed to shared/skills/
  // that a real push would still cover. Transient (one `nomad pull` migrates the
  // link) and no new leak (that content was scanned when first pushed).
  if (stat === undefined || stat.isSymbolicLink()) return 0;
  const names = readdirSync(localSkills, { encoding: 'utf8' }).filter((n) => !isSkillExcluded(n));
  if (names.length === 0) return 0;
  copySkillsPush(localSkills, join(tmpRoot, 'shared', 'skills'));
  return names.length;
}

/**
 * Run a read-only gitleaks leak preview of what `nomad push` would stage for
 * this host: mapped session transcripts
 * (`shared/projects/<logical>/*.jsonl`), opted-in extras
 * (`shared/extras/<logical>/<dirname>`), and non-gsd user skills
 * (`shared/skills/<name>/...`).
 *
 * Skills parity: `stageSkills` mirrors `syncSkillsPush` so a secret in a user
 * skill file is surfaced by `nomad push --dry-run` at the same fidelity as a
 * real push (which scans skills via the post-`git add -A` staged-tree scan).
 * The preview stages into the throwaway tree only; `REPO_HOME/shared/skills` is
 * never written.
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
 * `recovery` below the tree. Side effects preserved: `process.exitCode` is set
 * on a leak (`EXIT.LEAK_BLOCKED` 5, matching a real push) and on a scan
 * crash/error (`1`, a generic failure). A scan that throws maps to a ✗
 * scan-error row with `exitCode = 1`: ENOENT (gitleaks/git absent) keeps the
 * "not on PATH" wording, any other error (e.g. EACCES) surfaces its real
 * message so the cause is not mislabeled. Nothing-to-scan maps to a neutral ℹ︎ row.
 *
 * Fails closed before any copy: an unsafe `logical` key (path separator or
 * `..`) raised by `assertSafeLogical` in the staging step propagates out as a
 * `NomadFatal` to `cmdPush`, and the `finally` still removes the temp tree.
 *
 * @param map - Parsed `path-map.json` (already in scope from `cmdPush`).
 * @param opts - Optional `selection` from `ManifestDiff`; when provided only
 *   the changed files are staged (delta scan), omitting files unchanged since
 *   the last push. Omit or pass `{}` for a full scan (cold start or
 *   `--full-scan`).
 * @returns The structured verdict for the Leak scan section.
 */
export function previewPushLeaks(
  map: PathMap,
  opts: { selection?: ManifestDiff } = {},
): LeakVerdict {
  const cacheDir = join(homedir(), '.cache', 'claude-nomad');
  mkdirSync(cacheDir, { recursive: true });
  const stamp = `${nowTimestamp()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  const tmpRoot = join(cacheDir, `push-preview-tree-${stamp}`);

  try {
    const sessionCount = stageSessions(tmpRoot, map, opts.selection?.changed);
    const extrasCount = stageExtras(tmpRoot, map);
    const skillCount = stageSkills(tmpRoot);
    if (sessionCount + extrasCount + skillCount === 0) {
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
