/**
 * Owns the `nomad doctor --check-shared` preflight reporter.
 *
 * Read-only diagnostic that runs gitleaks against the LOCAL session transcripts
 * `nomad push` would stage (each path-map entry mapped to this host), surfacing
 * leaks BEFORE the push pipeline fires. Stages a temp COPY of the live
 * transcripts into a throwaway git repo and delegates the scan + row emission
 * to `scanAndReport` (`./commands.doctor.check-shared.scan.ts`), which runs the
 * shared `scanStagedTree` (`gitleaks protect --staged`, the same mechanism push
 * uses), so the preflight cannot miss a secret the push gate would catch. Emits
 * doctor glyph rows + `process.exitCode` instead of throwing a FATAL.
 *
 * This file owns probe-readiness, temp-tree staging, and orchestration; the
 * findings classification + guidance composer live in the `.scan.ts` sibling.
 * All external calls use `execFileSync` argv-array form (PUSH-04).
 */

import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { red, yellow, failGlyph, warnGlyph } from './color.ts';
import { emitClean, scanAndReport } from './commands.doctor.check-shared.scan.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { CLAUDE_HOME, HOST, REPO_HOME, type PathMap } from './config.ts';
import { copyDirJsonlOnly } from './remap.ts';
import { nowTimestamp } from './utils.fs.ts';
import { encodePath, readJson } from './utils.json.ts';

/**
 * Result of staging the scan tree. `malformed` is true when `path-map.json`
 * exists but does not parse as JSON; the caller emits a FAIL row and stops
 * rather than letting the `SyntaxError` abort the whole doctor run.
 */
type ScanTree = {
  logicalToEncoded: Map<string, string>;
  staged: number;
  malformed: boolean;
};

/**
 * Build the temp staging tree under `tmpRoot/shared/projects/<logical>/` by
 * copying each local encoded session dir that maps to a path-map logical for
 * this host (exactly what `remapPush` would stage; same depth-0 `*.jsonl`
 * filter via `copyDirJsonlOnly`). Returns the `logical -> encoded-dir`
 * association (for the scrub-path hint) plus the count staged. A malformed
 * `path-map.json` sets `malformed: true` rather than throwing.
 */
function buildScanTree(tmpRoot: string): ScanTree {
  const logicalToEncoded = new Map<string, string>();
  let staged = 0;
  const mapPath = join(REPO_HOME, 'path-map.json');
  if (!existsSync(mapPath)) return { logicalToEncoded, staged, malformed: false };
  let map: PathMap;
  try {
    map = readJson<PathMap>(mapPath);
  } catch {
    return { logicalToEncoded, staged, malformed: true };
  }
  if (typeof map.projects !== 'object' || map.projects === null) {
    return { logicalToEncoded, staged, malformed: false };
  }

  const reverse = new Map<string, string>();
  for (const [logical, hosts] of Object.entries(map.projects)) {
    if (typeof hosts !== 'object' || hosts === null) continue;
    const p = hosts[HOST];
    if (!p || p === 'TBD') continue;
    reverse.set(encodePath(p), logical);
  }

  const localProjects = join(CLAUDE_HOME, 'projects');
  if (!existsSync(localProjects)) return { logicalToEncoded, staged, malformed: false };
  for (const dir of readdirSync(localProjects)) {
    const logical = reverse.get(dir);
    if (!logical) continue;
    copyDirJsonlOnly(join(localProjects, dir), join(tmpRoot, 'shared', 'projects', logical));
    logicalToEncoded.set(logical, dir);
    staged++;
  }
  return { logicalToEncoded, staged, malformed: false };
}

/**
 * Probe for the gitleaks binary on PATH, distinguishing the not-installed case
 * (ENOENT -> `'missing'`, a WARN skip) from a real probe failure (EACCES,
 * corrupt binary -> `{ fail: message }`, a FAIL). Mirrors `reportGitleaksProbe`'s
 * ENOENT-vs-other split; probes directly so the doctor flavor stays read-only.
 */
function probeGitleaksForScan(): 'ok' | 'missing' | { fail: string } {
  try {
    execFileSync('gitleaks', ['version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return 'ok';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return { fail: (err as Error).message };
  }
}

/**
 * Probe-readiness guard ladder. Returns true to proceed to the scan, false to
 * stop after emitting an early row. When the orchestrator already probed
 * (`gitleaksReady === true`) the subcommand is not re-invoked; otherwise this
 * probes for itself, mapping `missing` to a WARN skip (exit untouched) and a
 * non-ENOENT failure to a FAIL row + `process.exitCode = 1`.
 */
function ensureGitleaksReady(section: DoctorSection, gitleaksReady?: boolean): boolean {
  if (gitleaksReady === true) return true;
  const probe = probeGitleaksForScan();
  if (probe === 'missing') {
    addItem(section, `${yellow(warnGlyph)} gitleaks not on PATH; shared scan skipped`);
    return false;
  }
  if (probe !== 'ok') {
    addItem(section, `${red(failGlyph)} gitleaks probe failed: ${probe.fail}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

/**
 * Run the `--check-shared` preflight and append its rows to `section`.
 *
 * Thin orchestrator (D-01..D-10): `ensureGitleaksReady` gates entry (a missing
 * binary WARN-skips, a probe failure FAILs); `buildScanTree` stages a temp copy
 * of this-host mapped session dirs (a malformed `path-map.json` -> FAIL row,
 * no crash); `scanAndReport` runs the shared `scanStagedTree` (the same
 * mechanism push uses, so the preflight cannot miss what push catches) and
 * emits the clean / leak / scan-failed rows, setting `process.exitCode = 1` on
 * any failure. The temp report + tree (including the injected throwaway `.git`)
 * are removed in `finally` on every path. Never writes to stderr (read-only
 * doctor contract: `scanStagedTree` runs with `forwardStreams` left false).
 *
 * `gitleaksReady` lets the doctor orchestrator pass the Repository section's
 * probe result so `version` is not invoked twice on a `--check-shared` run;
 * when omitted (the standalone contract) this reporter probes for itself.
 */
export function reportCheckShared(section: DoctorSection, gitleaksReady?: boolean): void {
  if (!ensureGitleaksReady(section, gitleaksReady)) return;

  const cacheDir = join(homedir(), '.cache', 'claude-nomad');
  mkdirSync(cacheDir, { recursive: true });
  // nowTimestamp() is second-resolution and --check-shared takes no lock
  // (read-only), so two same-second, same-pid invocations would otherwise
  // share a stamp and clobber each other's temp tree / report. The random
  // suffix makes the stamp collision-resistant, matching the push report path.
  const stamp = `${nowTimestamp()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  const reportPath = join(cacheDir, `check-shared-${stamp}.json`);
  const tmpRoot = join(cacheDir, `check-shared-tree-${stamp}`);

  try {
    const { logicalToEncoded, staged, malformed } = buildScanTree(tmpRoot);
    if (malformed) {
      addItem(section, `${red(failGlyph)} path-map.json malformed JSON; shared scan skipped`);
      process.exitCode = 1;
      return;
    }
    if (staged === 0) {
      // No path-map entry maps to this host (or all are TBD). Nothing would be
      // staged by push either, so report clean without invoking gitleaks (a
      // scan of a non-existent dir would exit non-zero and misfire).
      emitClean(section, 0);
      return;
    }
    // Scan the temp tree through the SAME mechanism push uses (scanStagedTree:
    // git init + add + gitleaks protect --staged), so the preflight cannot miss
    // a secret the push gate would catch. forwardStreams stays false so the
    // read-only doctor never writes gitleaks output to stderr; the injected
    // throwaway .git under tmpRoot is removed by the finally below.
    scanAndReport(section, tmpRoot, staged, logicalToEncoded);
  } finally {
    rmSync(reportPath, { force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
