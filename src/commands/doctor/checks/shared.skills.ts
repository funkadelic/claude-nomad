/**
 * Owns the committed-skills advisory folded into `nomad doctor --check-shared`.
 *
 * Sibling of `./commands.doctor.check-shared.memory.ts`, mirroring its exact
 * shape for `shared/skills/**` instead of `shared/projects/<logical>/memory/*.md`:
 * a secret that already rode a prior push into a committed skill file has no
 * advisory surface outside an actual push. This module closes that gap by
 * sourcing every committed skill blob from the sync repo's `HEAD` (via `git
 * ls-tree` + `git cat-file`, never a working-tree copy) into a fresh temp
 * tree (never scanning `repoHome()` in place, which would `git add -A` the
 * real repo index as a side effect of a read-only doctor check) and scanning
 * the copy through the same `scanStagedTree` mechanism push and the
 * local-preview scan use. Unlike the flat `memory/*.md` scope, skill content
 * nests arbitrarily deep (`SKILL.md`, `references/*.md`, etc.), so the source
 * pattern here is recursive and extension-agnostic.
 *
 * NOTE: this file is distinct from the pre-existing, unrelated
 * `./commands.doctor.checks.skills.ts` (plural `checks`), which is a
 * copy-sync divergence check between local and repo skill trees, not a
 * secret scan. The singular `check-shared` token in this filename mirrors
 * `commands.doctor.check-shared.memory.ts`'s naming.
 *
 * WARN-only, never FAIL: a finding here is retroactive (it already left in a
 * prior push), not blocking, so `process.exitCode` is never set by this
 * module on any path. Never throws: a scan failure or an unparseable report
 * both collapse to a single WARN-skip row rather than aborting the doctor
 * run mid-output.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { dim, warnGlyph, yellow } from '../../../color.ts';
import { addItem, type DoctorSection } from '../format.ts';
import { repoHome } from '../../../config.ts';
import { type Finding, scanStagedTree } from '../../push/gitleaks.ts';
import { nowTimestamp } from '../../../utils.fs.ts';

/**
 * Matches a committed, repo-relative POSIX path of the form
 * `shared/skills/<name>/<relPath>` as returned by `git ls-tree --name-only`.
 * Recursive and extension-agnostic (unlike the memory advisory's flat
 * `.md`-only scope): skill content legitimately nests under directories like
 * `references/` and can be authored in any file type.
 */
const SKILL_PATH = /^shared\/skills\/([^/]+)\/(.+)$/;

/**
 * Result of a scan-tree build: how many distinct skill names were staged, and
 * whether the build was incomplete (at least one committed blob could not be
 * materialized). `incomplete` is the fail-safe signal for a security advisory:
 * a partial tree must never be scanned and reported clean, because the one blob
 * that failed to read could be the only leaking file.
 */
export type SkillScanBuild = { staged: number; incomplete: boolean };

/**
 * Materialize every committed skill blob from the sync repo's `HEAD` into
 * `tmpRoot/shared/skills/<name>/<relPath>`. Sourcing from `HEAD` (via `git
 * ls-tree` + `git cat-file`) rather than `cpSync`-ing the working tree is
 * load-bearing: a dirty or deleted local file must not hide a secret that is
 * still committed and cloneable. Copying into a fresh temp dir first is also
 * load-bearing: `scanStagedTree` runs `git add -A` internally, which against
 * the real `repoHome()` would mutate the actual repo's index.
 *
 * Every committed `shared/skills/**` file is staged, INCLUDING `gsd-*`
 * skills: this is a read-only advisory and a stale committed `gsd-*` blob is
 * already cloneable, so excluding it would yield a false-clean result. (The
 * push-recovery REDACT path still excludes `gsd-*` skills, since those are not
 * safe to auto-modify; here we only surface, never mutate.)
 *
 * Returns `{ staged, incomplete }`. `staged` is 0 with `incomplete: false` on
 * any git failure that prevents listing at all (empty repo, not a git repo,
 * `git` missing, `shared/skills` absent from `HEAD`): legitimately "nothing to
 * check". `incomplete` is true when a listed blob's `git cat-file` failed, so
 * the caller fails safe and emits a WARN-skip instead of scanning a subset.
 *
 * @param tmpRoot Absolute path to the (not-yet-existing) temp scan tree.
 * @returns The staged distinct-name count and an incomplete-materialization flag.
 */
export function buildSkillScanTree(tmpRoot: string): SkillScanBuild {
  let paths: string[];
  try {
    const out = execFileSync(
      'git',
      ['-C', repoHome(), 'ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', 'shared/skills'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 },
    );
    paths = out.split('\0').filter((p) => p.length > 0);
  } catch {
    return { staged: 0, incomplete: false };
  }

  const names = new Set<string>();
  let incomplete = false;
  for (const rel of paths) {
    const m = SKILL_PATH.exec(rel);
    if (m?.[1] === undefined) continue;
    let blob: Buffer;
    try {
      blob = execFileSync('git', ['-C', repoHome(), 'cat-file', 'blob', `HEAD:${rel}`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 67108864,
        timeout: 10000,
      });
    } catch {
      // Fail safe: a blob we could not read might be the only leaking file, so
      // flag the whole build incomplete rather than silently scanning a subset.
      incomplete = true;
      continue;
    }
    const dest = join(tmpRoot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, blob);
    names.add(m[1]);
  }
  return { staged: names.size, incomplete };
}

/**
 * Emit one WARN row per finding, naming `File` + `RuleID` only, never
 * `Match`/the matched secret (mirrors `reportMemoryFindings`'s disclosure
 * convention). Does NOT set `process.exitCode`: a committed-skill finding
 * does not block anything, it is purely retroactive. Followed by a
 * remediation hint pointing at the push-recovery Redact path, plus a note
 * that `gsd-*` skills are not auto-redactable and must be removed by hand
 * (the advisory surfaces them, but the redact path deliberately excludes
 * gsd-owned skills).
 */
function reportSkillFindings(section: DoctorSection, findings: Finding[]): void {
  for (const f of findings) {
    addItem(section, `${yellow(warnGlyph)} ${f.RuleID} in ${f.File}`);
  }
  addItem(
    section,
    `  ${dim('run `nomad push` and choose Redact in the recovery menu to scrub these')}`,
  );
  addItem(
    section,
    `  ${dim('a gsd-* skill is not auto-redactable; remove the secret from it by hand')}`,
  );
}

/**
 * Run the committed-skills advisory and append its rows to `section`.
 *
 * Self-contained orchestrator: builds its own collision-resistant temp dir
 * under `~/.cache/claude-nomad/` (mirroring the stamp shape in the memory
 * advisory and `reportCheckShared`), stages a copy via `buildSkillScanTree`,
 * and scans it via `scanStagedTree`. Zero staged skill names emits nothing
 * (no committed skill content to check). Manages its own `finally` cleanup,
 * so it does not need to share `reportCheckShared`'s temp-tree lifecycle.
 *
 * Never throws and never sets `process.exitCode`: the ENTIRE body (including
 * its own `mkdirSync(cacheDir)` and `buildSkillScanTree`, not just the scan
 * call) is wrapped in one outer `try/catch` so any failure anywhere in the
 * advisory collapses to a single WARN-skip row rather than escaping and
 * aborting the whole `--check-shared` run mid-output. An empty findings
 * array is silent (clean, no row); a non-empty array is reported via
 * `reportSkillFindings`. The temp-tree path is computed inside the `try` (so
 * a failure before it is assigned leaves `tmpRoot` undefined) and the
 * `finally` cleanup itself is guarded: a `rmSync` failure is swallowed
 * rather than escaping the `finally` block, which would otherwise abort the
 * doctor run even though this advisory is WARN-only.
 *
 * @param section The doctor section to append WARN rows to.
 */
export function reportCommittedSkills(section: DoctorSection): void {
  let tmpRoot: string | undefined;
  try {
    const cacheDir = join(homedir(), '.cache', 'claude-nomad');
    mkdirSync(cacheDir, { recursive: true });
    // See reportCheckShared's stamp comment: the random suffix makes the temp
    // dir collision-resistant against two same-second, same-pid invocations.
    const stamp = `${nowTimestamp()}-${process.pid}-${randomBytes(4).toString('hex')}`;
    tmpRoot = join(cacheDir, `check-shared-skills-tree-${stamp}`);
    // Owner-only (0o700): the staged copies are committed skill blobs that may
    // contain the very secrets this advisory scans for, so a 0o700 root keeps
    // another local user from reading them out of the temp tree mid-scan.
    mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
    const { staged, incomplete } = buildSkillScanTree(tmpRoot);
    // Fail safe: an incomplete materialization must never scan-and-report
    // clean, since the unreadable blob could be the only leaking file. Emit
    // the same WARN-skip shape used when the scan itself cannot complete.
    if (incomplete) {
      addItem(
        section,
        `${yellow(warnGlyph)} committed-skills scan skipped: could not read every committed skill blob`,
      );
      return;
    }
    if (staged === 0) return;

    let findings: Finding[] | null;
    try {
      // Never scan repoHome() directly: scanStagedTree runs `git add -A`
      // internally, which would mutate the real repo's index. tmpRoot is a
      // throwaway copy built by buildSkillScanTree above.
      findings = scanStagedTree(tmpRoot);
    } catch (err) {
      addItem(
        section,
        `${yellow(warnGlyph)} committed-skills scan skipped: ${(err as Error).message}`,
      );
      return;
    }
    if (findings === null) {
      addItem(
        section,
        `${yellow(warnGlyph)} committed-skills scan skipped: no parseable gitleaks report`,
      );
      return;
    }
    if (findings.length === 0) return;
    reportSkillFindings(section, findings);
  } catch (err) {
    addItem(
      section,
      `${yellow(warnGlyph)} committed-skills scan skipped: ${(err as Error).message}`,
    );
  } finally {
    if (tmpRoot !== undefined) {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // Cleanup failure must never abort the doctor run: this advisory is
        // WARN-only and never sets process.exitCode.
      }
    }
  }
}
