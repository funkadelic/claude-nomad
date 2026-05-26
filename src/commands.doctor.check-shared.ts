/**
 * Owns the `nomad doctor --check-shared` preflight reporter.
 *
 * Read-only diagnostic that runs gitleaks against the LOCAL session
 * transcripts `nomad push` would stage (each path-map entry mapped to this
 * host), surfacing secret leaks BEFORE the push pipeline fires. Shares the
 * push-time scan mechanism (`scanStagedTree` in `./push-gitleaks.scan.ts`,
 * also used by `runGitleaksScan`): it stages a temp COPY of the live
 * transcripts (never the live dir) into a throwaway git repo and scans it with
 * `gitleaks protect --staged`, so the preflight cannot miss a secret the push
 * gate would catch. It emits doctor-flavored glyph rows + `process.exitCode`
 * instead of throwing a push-flavored FATAL.
 *
 * Composition only: reuses `scanStagedTree` (the shared git-stage + scan),
 * `partitionFindings` / `SESSION_PATH` (the gitleaks JSON classifier), and
 * `copyDirJsonlOnly` (the push-fidelity source filter) verbatim. The
 * doctor-flavored guidance composer is new (push's `buildSessionAwareFatal` is
 * wrong at doctor time: `nomad drop-session` operates on the staged tree, and
 * nothing is staged during a preflight).
 *
 * All external calls use `execFileSync` argv-array form (no shell), the
 * codebase PUSH-04 invariant.
 */

import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { green, red, yellow, okGlyph, failGlyph, warnGlyph } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { CLAUDE_HOME, HOST, REPO_HOME, type PathMap } from './config.ts';
import { type Finding, partitionFindings, scanStagedTree } from './push-gitleaks.ts';
import { copyDirJsonlOnly } from './remap.ts';
import { nowTimestamp } from './utils.fs.ts';
import { encodePath, readJson } from './utils.json.ts';

/**
 * Result of staging the scan tree. `malformed` is true when `path-map.json`
 * exists but does not parse as JSON; the caller emits a FAIL row and stops
 * (mirroring `reportPathMap`'s `readJsonSafe` degradation) rather than letting
 * the `SyntaxError` propagate past `nomad.ts`'s `NomadFatal`-only handler and
 * abort the whole doctor run with a stack trace.
 */
type ScanTree = {
  logicalToEncoded: Map<string, string>;
  staged: number;
  malformed: boolean;
};

/**
 * Build the temp staging tree under `tmpRoot/shared/projects/<logical>/` by
 * copying each local encoded session dir that resolves to a path-map logical
 * for this host. Returns the `logical -> encoded-dir` association so the
 * scrub-path hint can name the live `~/.claude/projects/<encoded>/<sid>.jsonl`
 * file, plus the count of session dirs staged. Skips `TBD`/unmapped entries
 * (the D-03 scope: exactly what `remapPush` would stage). Uses the same
 * depth-0 `*.jsonl` filter as push via `copyDirJsonlOnly`. A malformed
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
 * (ENOENT -> `'missing'`, a WARN skip per the read-only doctor contract) from a
 * real probe failure (EACCES, corrupt binary -> `{ fail: message }`, a FAIL).
 * Mirrors `reportGitleaksProbe`'s ENOENT-vs-other split rather than collapsing
 * every failure into "not on PATH". Probes directly (not via `probeGitleaks`)
 * so the doctor flavor stays read-only and need not unwrap a `NomadFatal`.
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
 * Recover the live encoded-dir for a finding by mapping its `<logical>`
 * segment through the staging association. Returns the absolute live
 * transcript path `~/.claude/projects/<encoded>/<sid>.jsonl`, falling back to
 * the logical name when the association is missing (defensive; the temp-tree
 * model guarantees a hit).
 */
function scrubPath(logical: string, sid: string, logicalToEncoded: Map<string, string>): string {
  /* c8 ignore next -- the `?? logical` fallback is defensive; the temp-tree build keys every staged logical */
  const encoded = logicalToEncoded.get(logical) ?? logical;
  return join(CLAUDE_HOME, 'projects', encoded, `${sid}.jsonl`);
}

/**
 * Emit one fail row per affected session plus rotate-and-scrub + allowlist
 * guidance, and set `process.exitCode = 1`. `logicalBySession` carries the
 * `<logical>` segment captured from the same `SESSION_PATH` match that keyed
 * `bySession`, so the scrub-path hint reuses the authoritative parse rather
 * than re-deriving the logical name from the finding `File`. Every `bySession`
 * sid is keyed in `logicalBySession` (both come from the identical sid capture),
 * so the scrub hint always renders; the guard omits the hint rather than
 * printing a wrong path if that invariant ever breaks, and the leak row itself
 * is always emitted.
 */
function reportSessionFindings(
  section: DoctorSection,
  bySession: Map<string, Map<string, number>>,
  logicalBySession: Map<string, string>,
  logicalToEncoded: Map<string, string>,
): void {
  for (const [sid, counts] of bySession) {
    const summary = [...counts.entries()].map(([rule, n]) => `${rule} (${n})`).join(', ');
    addItem(section, `${red(failGlyph)} session ${sid}: ${summary}`);
    const logical = logicalBySession.get(sid);
    /* c8 ignore next -- false branch is defensive; every bySession sid is keyed in logicalBySession */
    if (logical !== undefined) {
      addItem(
        section,
        `  rotate the credential, then scrub ${scrubPath(logical, sid, logicalToEncoded)}`,
      );
    }
    addItem(section, `  false positive? add a pattern to .gitleaks.toml`);
  }
  process.exitCode = 1;
}

/**
 * Emit one fail row per non-session ("other"-bucket) finding and set
 * `process.exitCode = 1`. These are findings whose `File` did not match the
 * flat `SESSION_PATH` shape (nested transcripts under `subagents/`, `memory/`,
 * etc., which `copyDirJsonlOnly` copies recursively and `nomad push` would
 * stage). Names the repo-relative path and RuleID only, never the matched
 * secret. Mirrors the push-side guarantee that any finding outside `bySession`
 * still fails the scan (`buildSessionAwareFatal`'s `LEGACY_FATAL` fallback).
 */
function reportOtherFindings(section: DoctorSection, other: Finding[]): void {
  for (const f of other) {
    addItem(section, `${red(failGlyph)} leak in ${f.File}: ${f.RuleID}`);
  }
  process.exitCode = 1;
}

/**
 * Captures both the `<logical>` segment and the `<sid>` from a repo-relative
 * `shared/projects/<logical>/<sid>.jsonl` path. The session-id group matches
 * the exported `SESSION_PATH` shape; the extra `<logical>` group lets the
 * scrub-path hint reuse this single authoritative parse.
 */
const SESSION_PATH_LOGICAL = /^shared\/projects\/([^/]+)\/([^/]+)\.jsonl$/;

/**
 * Emit the single canonical clean row reporting the scanned-project count
 * (`staged` is the number of mapped project directories whose transcripts were
 * staged, not a transcript total). Centralizing the literal (zero-staged,
 * scanned-clean, and the findings-but-no-`other` paths all route through here)
 * keeps the phrasing consistent and prevents one copy drifting from another,
 * which is what let a "no session findings == clean" path slip past the
 * `other`-bucket gate.
 */
function emitClean(section: DoctorSection, staged: number): void {
  addItem(section, `${green(okGlyph)} ${staged} project(s) scanned, no leaks`);
}

/**
 * Run the `--check-shared` preflight and append its rows to `section`.
 *
 * Flow (D-01..D-10): probe gitleaks (missing -> one WARN row, exit untouched;
 * a non-ENOENT probe failure -> FAIL row + exit 1, mirroring
 * `reportGitleaksProbe`); stage a temp copy of this-host mapped session dirs
 * (a malformed `path-map.json` -> FAIL row + exit 1, no crash); scan the temp
 * tree through the shared `scanStagedTree` (git init + git add -A + gitleaks
 * protect --staged), the same mechanism push uses, so the preflight cannot miss
 * what push catches; on a clean scan emit one ok row reporting the
 * scanned-project count; on findings emit per-session fail rows with
 * rotate-and-scrub guidance and set `process.exitCode = 1`; on a scan failure
 * (ENOENT/git error, or a non-zero gitleaks exit with no parseable report) emit
 * a scan-failed fail row carrying the error message only (never stderr/stdout,
 * which may hold secrets) + exit 1 (do not chase phantom sessions). Removes the
 * temp tree (including the injected throwaway `.git`) in `finally` on success
 * and failure. Never writes to stderr (read-only doctor contract:
 * `scanStagedTree` is called with `forwardStreams` left false).
 *
 * `gitleaksReady` lets the doctor orchestrator pass the result of the
 * Repository section's gitleaks probe so the `version` subcommand is not
 * invoked a second time on a `--check-shared` run. When omitted (the module's
 * standalone contract) this reporter probes for itself.
 */
export function reportCheckShared(section: DoctorSection, gitleaksReady?: boolean): void {
  if (gitleaksReady !== true) {
    const probe = probeGitleaksForScan();
    if (probe === 'missing') {
      addItem(section, `${yellow(warnGlyph)} gitleaks not on PATH; shared scan skipped`);
      return;
    }
    if (probe !== 'ok') {
      addItem(section, `${red(failGlyph)} gitleaks probe failed: ${probe.fail}`);
      process.exitCode = 1;
      return;
    }
  }

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
    let findings: Finding[] | null;
    try {
      findings = scanStagedTree(tmpRoot);
    } catch (err) {
      // ENOENT (binary vanished mid-flow) or a git failure. The top-of-flow
      // probe WARN-skips a truly missing gitleaks; this catch reports a
      // scan-failed FAIL row with err.message only (never stderr/stdout, which
      // can echo redacted-but-sensitive scan output).
      addItem(section, `${red(failGlyph)} scan failed: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    if (findings === null) {
      // Non-zero gitleaks exit with no parseable report. Carry no stream
      // output, matching runGitleaksScan on the push side.
      addItem(section, `${red(failGlyph)} scan failed: no parseable gitleaks report`);
      process.exitCode = 1;
      return;
    }
    const { bySession, other } = partitionFindings(findings);
    // Both buckets must gate the clean row. A finding routed to `other` (nested
    // transcripts that match neither the flat SESSION_PATH nor any session) is
    // still a stageable secret push would catch, so reporting clean on
    // `bySession.size === 0` alone would make the preflight weaker than the push
    // scan it stands in for.
    if (bySession.size === 0 && other.length === 0) {
      emitClean(section, staged);
      return;
    }
    if (other.length > 0) reportOtherFindings(section, other);
    if (bySession.size > 0) {
      // Capture <logical> alongside <sid> from the same authoritative match so
      // the scrub hint never re-derives the logical name independently.
      const logicalBySession = new Map<string, string>();
      for (const f of findings) {
        const m = SESSION_PATH_LOGICAL.exec(f.File);
        if (m?.[2] !== undefined && !logicalBySession.has(m[2])) {
          /* c8 ignore next -- `?? ''` is defensive; group 1 is always captured when the match succeeds */
          logicalBySession.set(m[2], m[1] ?? '');
        }
      }
      reportSessionFindings(section, bySession, logicalBySession, logicalToEncoded);
    }
  } finally {
    rmSync(reportPath, { force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
