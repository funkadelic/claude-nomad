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
 * module on any path. Never throws: a scan failure or an unparseable report
 * both collapse to a single WARN-skip row rather than aborting the doctor
 * run mid-output.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { dim, warnGlyph, yellow } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { repoHome } from './config.ts';
import { type Finding, scanStagedTree } from './push-gitleaks.ts';
import { nowTimestamp } from './utils.fs.ts';

/**
 * Matches a committed, repo-relative POSIX path of the form
 * `shared/projects/<logical>/memory/<filename>.md` as returned by
 * `git ls-tree --name-only`. Deliberately flat: a nested
 * `memory/<subdir>/x.md` path (or any non-`.md` file under `memory/`) does
 * not match and is skipped, matching the documented flat `memory/*.md` scope.
 */
const MEMORY_MD_PATH = /^shared\/projects\/([^/]+)\/memory\/[^/]+\.md$/;

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
 * `memory/*.md` scope. Returns the count of distinct logicals staged; returns
 * 0 (no crash) on any git failure (empty repo, not a git repo, `git` missing,
 * or `shared/projects` absent from `HEAD`). Copying into a fresh temp dir
 * first is load-bearing for a separate reason: `scanStagedTree` internally
 * runs `git add -A`, and running that against the real `repoHome()` would
 * mutate the actual repo's index as a side effect of a read-only check.
 *
 * @param tmpRoot Absolute path to the (not-yet-existing) temp scan tree.
 * @returns The number of distinct `<logical>` memory dirs staged.
 */
export function buildMemoryScanTree(tmpRoot: string): number {
  let paths: string[];
  try {
    const out = execFileSync(
      'git',
      ['-C', repoHome(), 'ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', 'shared/projects'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 },
    );
    paths = out.split('\0').filter((p) => p.length > 0);
  } catch {
    return 0;
  }

  const logicals = new Set<string>();
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
      continue;
    }
    const dest = join(tmpRoot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, blob);
    logicals.add(m[1]);
  }
  return logicals.size;
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
    const staged = buildMemoryScanTree(tmpRoot);
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
