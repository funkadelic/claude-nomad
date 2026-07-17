/**
 * Owns the committed-memory advisory folded into `nomad doctor --check-shared`.
 *
 * `reportCheckShared` (`./commands.doctor.check-shared.ts`) scans the LOCAL
 * session transcripts a push would stage; it never reads the sync repo's own
 * already-committed content. A secret that already rode a prior push into
 * `shared/projects/<logical>/memory/*.md` therefore has no advisory surface
 * outside an actual push. This module closes that gap: it copies every
 * committed `memory/*.md` file into a fresh temp tree (never scanning
 * `repoHome()` in place, which would `git add -A` the real repo index as a
 * side effect of a read-only doctor check) and scans the copy through the
 * same `scanStagedTree` mechanism push and the local-preview scan use.
 *
 * WARN-only, never FAIL: a finding here is retroactive (it already left in a
 * prior push), not blocking, so `process.exitCode` is never set by this
 * module on any path. Never throws: a scan failure or an unparseable report
 * both collapse to a single WARN-skip row rather than aborting the doctor
 * run mid-output.
 */

import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { dim, warnGlyph, yellow } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { repoHome } from './config.ts';
import { type Finding, scanStagedTree } from './push-gitleaks.ts';
import { nowTimestamp } from './utils.fs.ts';

/**
 * Copy every committed `shared/projects/<logical>/memory/` directory from the
 * sync repo into `tmpRoot/shared/projects/<logical>/memory`, mirroring the
 * `buildScanTree` temp-copy pattern in the sibling `check-shared.ts` but
 * sourcing from `repoHome()` (the committed repo) instead of `claudeHome()`
 * (the local, not-yet-pushed transcripts). Returns the count of logicals
 * staged; returns 0 (no crash) when `shared/projects` does not exist. Copying
 * into a fresh temp dir first is load-bearing: `scanStagedTree` internally
 * runs `git add -A`, and running that against the real `repoHome()` would
 * mutate the actual repo's index as a side effect of a read-only check.
 *
 * @param tmpRoot Absolute path to the (not-yet-existing) temp scan tree.
 * @returns The number of `<logical>/memory` directories copied.
 */
export function buildMemoryScanTree(tmpRoot: string): number {
  const projectsDir = join(repoHome(), 'shared', 'projects');
  if (!existsSync(projectsDir)) return 0;
  let staged = 0;
  for (const logical of readdirSync(projectsDir)) {
    const memDir = join(projectsDir, logical, 'memory');
    if (!existsSync(memDir)) continue;
    cpSync(memDir, join(tmpRoot, 'shared', 'projects', logical, 'memory'), { recursive: true });
    staged++;
  }
  return staged;
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
 * `reportMemoryFindings`.
 *
 * @param section The doctor section to append WARN rows to.
 */
export function reportCommittedMemory(section: DoctorSection): void {
  const cacheDir = join(homedir(), '.cache', 'claude-nomad');
  // See reportCheckShared's stamp comment: the random suffix makes the temp
  // dir collision-resistant against two same-second, same-pid invocations.
  const stamp = `${nowTimestamp()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  const tmpRoot = join(cacheDir, `check-shared-memory-tree-${stamp}`);

  try {
    mkdirSync(cacheDir, { recursive: true });
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
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
