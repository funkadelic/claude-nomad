/**
 * Scan-result classification and row emission for the `nomad doctor
 * --check-shared` preflight. Split out of `commands.doctor.check-shared.ts` to
 * keep both files under the line cap; `reportCheckShared` (the public reporter)
 * stays in the sibling and calls `scanAndReport` after staging the temp tree.
 *
 * Owns the post-stage block: run the shared `scanStagedTree` (the same git
 * init + add + `gitleaks protect --staged` mechanism push uses), classify the
 * findings via `partitionFindings`, and emit the doctor glyph rows (clean,
 * per-session leak with rotate-and-scrub guidance, and the nested "other"
 * bucket). All external work flows through `scanStagedTree`; this module spawns
 * nothing itself.
 */

import { join } from 'node:path';

import { green, red, okGlyph, failGlyph } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { CLAUDE_HOME } from './config.ts';
import { type Finding, partitionFindings, scanStagedTree } from './push-gitleaks.ts';

/**
 * Recover the absolute live transcript path
 * `~/.claude/projects/<encoded>/<sid>.jsonl` by mapping the finding's
 * `<logical>` through the staging association, falling back to the logical name
 * when the association is missing (defensive; the temp-tree build guarantees a hit).
 */
function scrubPath(logical: string, sid: string, logicalToEncoded: Map<string, string>): string {
  /* c8 ignore next -- the `?? logical` fallback is defensive; the temp-tree build keys every staged logical */
  const encoded = logicalToEncoded.get(logical) ?? logical;
  return join(CLAUDE_HOME, 'projects', encoded, `${sid}.jsonl`);
}

/**
 * Emit one fail row per affected session plus rotate-and-scrub + allowlist
 * guidance, and set `process.exitCode = 1`. `logicalBySession` carries the
 * `<logical>` captured from the same match that keyed `bySession`, so the
 * scrub-path hint reuses the authoritative parse. The hint guard omits a row
 * rather than print a wrong path if the invariant ever breaks; the leak row is
 * always emitted.
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
 * which `nomad push` would still stage). Names the repo-relative path and
 * RuleID only, never the matched secret.
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
 * the exported `SESSION_PATH` shape; the `<logical>` group lets the scrub-path
 * hint reuse this single authoritative parse.
 */
const SESSION_PATH_LOGICAL = /^shared\/projects\/([^/]+)\/([^/]+)\.jsonl$/;

/**
 * Emit the single canonical clean row reporting the scanned-project count
 * (`staged` is the number of mapped project dirs staged, not a transcript
 * total). Centralizing the literal keeps every clean path (zero-staged,
 * scanned-clean, findings-but-no-`other`) phrased consistently.
 */
export function emitClean(section: DoctorSection, staged: number): void {
  addItem(section, `${green(okGlyph)} ${staged} project(s) scanned, no leaks`);
}

/**
 * Build the `sid -> <logical>` association from the findings, capturing both
 * groups from the same `SESSION_PATH_LOGICAL` match so the scrub-path hint
 * never re-derives the logical name. First match per sid wins (the scrub path
 * is per session, not per finding).
 */
function buildLogicalBySession(findings: Finding[]): Map<string, string> {
  const logicalBySession = new Map<string, string>();
  for (const f of findings) {
    const m = SESSION_PATH_LOGICAL.exec(f.File);
    if (m?.[2] !== undefined && !logicalBySession.has(m[2])) {
      /* c8 ignore next -- `?? ''` is defensive; group 1 is always captured when the match succeeds */
      logicalBySession.set(m[2], m[1] ?? '');
    }
  }
  return logicalBySession;
}

/**
 * Scan the staged temp tree through the shared `scanStagedTree` and emit the
 * result rows. Isolates the deepest nesting from `reportCheckShared`: the scan
 * try/catch (failure -> fail row + exit 1, carrying `err.message` only, never
 * stderr/stdout), the unparseable `findings === null` branch, `partitionFindings`,
 * and the clean / `other` / `bySession` rows. BOTH buckets gate the clean row: a
 * finding in `other` (nested transcripts matching neither the flat `SESSION_PATH`
 * nor any session) is still a stageable secret push would catch, so a
 * `bySession`-only gate would make the preflight weaker than the push scan.
 */
export function scanAndReport(
  section: DoctorSection,
  tmpRoot: string,
  staged: number,
  logicalToEncoded: Map<string, string>,
): void {
  let findings: Finding[] | null;
  try {
    findings = scanStagedTree(tmpRoot);
  } catch (err) {
    // ENOENT (binary vanished mid-flow) or a git failure. The top-of-flow probe
    // WARN-skips a truly missing gitleaks; this catch reports a scan-failed FAIL
    // row with err.message only (never stderr/stdout, which can echo
    // redacted-but-sensitive scan output).
    addItem(section, `${red(failGlyph)} scan failed: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (findings === null) {
    // Non-zero gitleaks exit with no parseable report. Carry no stream output,
    // matching runGitleaksScan on the push side.
    addItem(section, `${red(failGlyph)} scan failed: no parseable gitleaks report`);
    process.exitCode = 1;
    return;
  }
  const { bySession, other } = partitionFindings(findings);
  if (bySession.size === 0 && other.length === 0) {
    emitClean(section, staged);
    return;
  }
  if (other.length > 0) reportOtherFindings(section, other);
  if (bySession.size > 0) {
    reportSessionFindings(section, bySession, buildLogicalBySession(findings), logicalToEncoded);
  }
}
