/**
 * Owns the committed-memory advisory folded into `nomad doctor --check-shared`.
 *
 * `reportCheckShared` (`./commands.doctor.check-shared.ts`) scans the LOCAL
 * session transcripts a push would stage; it never reads the sync repo's own
 * already-committed content. A secret that already rode a prior push into
 * `shared/projects/<logical>/memory/*.md` therefore has no advisory surface
 * outside an actual push. This module closes that gap: it sources every
 * committed, flat `memory/*.md` file from the sync repo's `HEAD` (via `git
 * ls-tree` + `git cat-file`, never a working-tree copy, so a dirty or deleted
 * local file cannot change the result and nested/non-`.md` paths are out of
 * scope) into a fresh temp tree (never scanning `repoHome()` in place, which
 * would `git add -A` the real repo index as a side effect of a read-only
 * doctor check) and scans the copy through the same `scanStagedTree`
 * mechanism push and the local-preview scan use.
 *
 * WARN-only, never FAIL: a finding here is retroactive (it already left in a
 * prior push), not blocking, so `process.exitCode` is never set by this
 * module on any path. Never throws: a scan failure, an unparseable report, or
 * an incomplete blob materialization all collapse to a single WARN-skip row
 * rather than aborting the doctor run mid-output. The incomplete-materialization
 * case fails safe (WARN-skip, never a clean pass), because a blob that could
 * not be read might be the only leaking file.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { dim, warnGlyph, yellow } from '../../../color.ts';
import { addItem, type DoctorSection } from '../format.ts';
import { repoHome } from '../../../config.ts';
import { type Finding, scanStagedTree } from '../../../push-gitleaks.ts';
import { nowTimestamp } from '../../../utils.fs.ts';

/**
 * Matches a committed, repo-relative POSIX path of the form
 * `shared/projects/<logical>/memory/<filename>.md` as returned by
 * `git ls-tree --name-only`. Deliberately flat: a nested
 * `memory/<subdir>/x.md` path (or any non-`.md` file under `memory/`) does
 * not match and is skipped, matching the documented flat `memory/*.md` scope.
 */
const MEMORY_MD_PATH = /^shared\/projects\/([^/]+)\/memory\/[^/]+\.md$/;

/**
 * Result of a scan-tree build: how many distinct logicals were staged, and
 * whether the build was incomplete (at least one committed blob could not be
 * materialized). `incomplete` is the fail-safe signal for a security advisory:
 * a partial tree must never be scanned and reported clean, because the one blob
 * that failed to read could be the only leaking file. Mirrors the sibling
 * skills advisory's `SkillScanBuild`.
 */
export type MemoryScanBuild = { staged: number; incomplete: boolean };

/**
 * Materialize every committed, flat `memory/*.md` blob from the sync repo's
 * `HEAD` into `tmpRoot/shared/projects/<logical>/memory/<file>`, mirroring
 * the `buildScanTree` temp-copy pattern in the sibling `check-shared.ts` but
 * sourcing from the committed `HEAD` (via `git ls-tree` + `git cat-file`)
 * instead of `cpSync`-ing `repoHome()`'s live working tree. Sourcing from
 * `HEAD` is load-bearing: a `cpSync` of the working tree would let an
 * uncommitted local deletion hide a secret that is still committed and
 * reachable by anyone who clones the repo, and would recursively copy
 * anything nested under `memory/` rather than enforcing the documented flat
 * `memory/*.md` scope. Copying into a fresh temp dir first is load-bearing for
 * a separate reason: `scanStagedTree` internally runs `git add -A`, and running
 * that against the real `repoHome()` would mutate the actual repo's index as a
 * side effect of a read-only check.
 *
 * Returns `{ staged, incomplete }`. `staged` is 0 with `incomplete: false` on
 * any git failure that prevents listing at all (empty repo, not a git repo,
 * `git` missing, `shared/projects` absent from `HEAD`): legitimately "nothing
 * to check". `incomplete` is true when a listed blob's `git cat-file` failed,
 * so the caller fails safe and emits a WARN-skip instead of scanning a subset.
 *
 * @param tmpRoot Absolute path to the (not-yet-existing) temp scan tree.
 * @returns The staged distinct-logical count and an incomplete-materialization flag.
 */
export function buildMemoryScanTree(tmpRoot: string): MemoryScanBuild {
  let paths: string[];
  try {
    const out = execFileSync(
      'git',
      ['-C', repoHome(), 'ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', 'shared/projects'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 },
    );
    paths = out.split('\0').filter((p) => p.length > 0);
  } catch {
    return { staged: 0, incomplete: false };
  }

  const logicals = new Set<string>();
  let incomplete = false;
  for (const rel of paths) {
    const m = MEMORY_MD_PATH.exec(rel);
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
    logicals.add(m[1]);
  }
  return { staged: logicals.size, incomplete };
}

/**
 * Emit one WARN row per finding, naming `File` + `RuleID` only, never
 * `Match`/the matched secret (mirrors `reportOtherFindings`'s disclosure
 * convention). Does NOT set `process.exitCode`: unlike the local-preview
 * scan's FAIL emitters, a committed-memory finding does not block anything,
 * it is purely retroactive. Followed by a single remediation hint pointing at
 * the push-recovery Redact path, which already has memory-aware redaction
 * support.
 */
function reportMemoryFindings(section: DoctorSection, findings: Finding[]): void {
  for (const f of findings) {
    addItem(section, `${yellow(warnGlyph)} ${f.RuleID} in ${f.File}`);
  }
  addItem(
    section,
    `  ${dim('run `nomad push` and choose Redact in the recovery menu to scrub these')}`,
  );
}

/**
 * Run the committed-memory advisory and append its rows to `section`.
 *
 * Self-contained orchestrator: builds its own collision-resistant temp dir
 * under `~/.cache/claude-nomad/` (mirroring the stamp shape in
 * `reportCheckShared`), stages a copy via `buildMemoryScanTree`, and scans it
 * via `scanStagedTree`. Zero staged logicals emits nothing (no committed
 * memory content to check). Manages its own `finally` cleanup, so it does not
 * need to share `reportCheckShared`'s temp-tree lifecycle and a failure here
 * can never leave the local-preview scan's temp tree behind.
 *
 * Never throws and never sets `process.exitCode`: the ENTIRE body (including
 * its own `mkdirSync(cacheDir)` and `buildMemoryScanTree`, not just the scan
 * call) is wrapped in one outer `try/catch` so any failure anywhere in the
 * advisory -- not only a `scanStagedTree` throw or a `null` (unparseable)
 * report -- collapses to a single WARN-skip row rather than escaping and
 * aborting the whole `--check-shared` run mid-output. An empty findings array
 * is silent (clean, no row); a non-empty array is reported via
 * `reportMemoryFindings`. The temp-tree path is computed inside the `try` (so
 * a failure before it is assigned leaves `tmpRoot` undefined) and the
 * `finally` cleanup itself is guarded: a `rmSync` failure is swallowed rather
 * than escaping the `finally` block, which would otherwise abort the doctor
 * run even though this advisory is WARN-only.
 *
 * @param section The doctor section to append WARN rows to.
 */
export function reportCommittedMemory(section: DoctorSection): void {
  let tmpRoot: string | undefined;
  try {
    const cacheDir = join(homedir(), '.cache', 'claude-nomad');
    mkdirSync(cacheDir, { recursive: true });
    // See reportCheckShared's stamp comment: the random suffix makes the temp
    // dir collision-resistant against two same-second, same-pid invocations.
    const stamp = `${nowTimestamp()}-${process.pid}-${randomBytes(4).toString('hex')}`;
    tmpRoot = join(cacheDir, `check-shared-memory-tree-${stamp}`);
    // Owner-only (0o700): the staged copies are committed memory blobs that may
    // contain the very secrets this advisory scans for, so a 0o700 root keeps
    // another local user from reading them out of the temp tree mid-scan.
    mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
    const { staged, incomplete } = buildMemoryScanTree(tmpRoot);
    // Fail safe: an incomplete materialization must never scan-and-report
    // clean, since the unreadable blob could be the only leaking file. Emit
    // the same WARN-skip shape used when the scan itself cannot complete.
    if (incomplete) {
      addItem(
        section,
        `${yellow(warnGlyph)} committed-memory scan skipped: could not read every committed memory blob`,
      );
      return;
    }
    if (staged === 0) return;

    let findings: Finding[] | null;
    try {
      // Never scan repoHome() directly: scanStagedTree runs `git add -A`
      // internally, which would mutate the real repo's index. tmpRoot is a
      // throwaway copy built by buildMemoryScanTree above.
      findings = scanStagedTree(tmpRoot);
    } catch (err) {
      addItem(
        section,
        `${yellow(warnGlyph)} committed-memory scan skipped: ${(err as Error).message}`,
      );
      return;
    }
    if (findings === null) {
      addItem(
        section,
        `${yellow(warnGlyph)} committed-memory scan skipped: no parseable gitleaks report`,
      );
      return;
    }
    if (findings.length === 0) return;
    reportMemoryFindings(section, findings);
  } catch (err) {
    addItem(
      section,
      `${yellow(warnGlyph)} committed-memory scan skipped: ${(err as Error).message}`,
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
