/**
 * Owns the push-side gitleaks orchestration invoked at the end of `cmdPush`:
 * the session-aware FATAL builder (`partitionFindings` + `buildSessionAwareFatal`)
 * and `runGitleaksScan`, which delegates the git-stage + scan mechanism to the
 * shared `scanStagedTree` in `./push-gitleaks.scan.ts`.
 *
 * Lives in its own module (split from `push-checks.ts`) so the FATAL builder
 * has a clean home while keeping every file under the 200-line cap.
 * `findGitlinks`, `probeGitleaks`, `gitleaksInstallHint`, and `rebaseBeforePush`
 * stay in `push-checks.ts`. The staged-scan primitives (`Finding`,
 * `readGitleaksReport`, `scanStagedTree`) live in `./push-gitleaks.scan.ts` and
 * are re-exported here so existing import sites are unaffected.
 *
 * `gitleaksInstallHint` is imported from `./push-checks.ts` because the
 * ENOENT branch surfaces the same platform-aware install scaffold whether
 * the missing binary is detected by `probeGitleaks` (top-of-flow) or by
 * this scan (defense-in-depth mid-flow).
 */

import { repoHome } from './config.ts';
import { gitleaksInstallHint } from './push-checks.ts';
import { type Finding, scanStagedTree } from './push-gitleaks.scan.ts';
import { NomadFatal } from './utils.ts';

// Re-export the staged-scan primitives (moved to ./push-gitleaks.scan.ts to
// keep both this module and commands.doctor.check-shared.ts under the 200-line
// cap) so existing `from './push-gitleaks.ts'` import sites stay unchanged and
// push + the --check-shared preflight share one scan mechanism.
export { type Finding, scanStagedTree };

/**
 * Captures the session id from a repo-relative POSIX path of the form
 * `shared/projects/<logical>/<sid>.jsonl`. gitleaks emits forward-slash
 * paths regardless of host OS, so the literal works cross-platform.
 * Anchored at both ends + depth-4 segments by construction so deeper
 * paths (e.g., `shared/projects/<logical>/subagents/<id>.jsonl`) fall
 * through to the non-session `other` bucket.
 */
export const SESSION_PATH = /^shared\/projects\/[^/]+\/([^/]+)\.jsonl$/;

/**
 * Extracts the session id from a subagent TRANSCRIPT path of the form
 * `shared/projects/<logical>/<id>/.../<file>.jsonl`. The nested entry MUST end
 * in `.jsonl` to distinguish a genuine subagent transcript from non-transcript
 * paths under the same directory (e.g. `memory/notes.md`, `README`).
 * Requiring `.jsonl` prevents "memory" from being captured as a session id when
 * the path is `shared/projects/<logical>/memory/notes.md`.
 */
const SUBAGENT_SESSION_PATH = /^shared\/projects\/[^/]+\/([^/]+)\/.*\.jsonl$/;

/**
 * Legacy fallback FATAL emitted when no finding's File matches the session
 * path pattern. Locked verbatim so existing tests covering the non-session
 * path do not regress.
 */
const LEGACY_FATAL =
  'gitleaks detected secrets; review staged changes with git diff --cached and unstage offending files before retry';

/**
 * Build a stable identity key for a finding used by `dedupeFindings`.
 * Prefers a non-empty `Fingerprint` (gitleaks-generated, unique per distinct
 * secret span) and falls back to `File:RuleID:StartLine:StartColumn` when the
 * Fingerprint is missing, non-string, or empty. The report is parsed from
 * untyped gitleaks JSON, so the runtime type guard prevents a missing/null
 * Fingerprint from collapsing distinct findings into one key (undercounting).
 *
 * @param f The finding to key.
 * @returns A string key that uniquely identifies the finding span.
 */
function findingIdentityKey(f: Finding): string {
  const fp = f.Fingerprint;
  return typeof fp === 'string' && fp.length > 0
    ? fp
    : `${f.File}:${f.RuleID}:${f.StartLine}:${f.StartColumn}`;
}

/**
 * Deduplicate a findings array, preserving first-seen order.
 * Collapses findings by `Fingerprint` when non-empty, otherwise by
 * `File:RuleID:StartLine:StartColumn`. Applied at the entry point of
 * `partitionFindings` so every consumer (report builder and verdict row)
 * operates on the same stable set, eliminating the dry-run vs real-push
 * count divergence and the repeated `Also found:` rows.
 *
 * @param findings The raw findings array from the scanner.
 * @returns A new array with duplicate findings removed.
 */
function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];
  for (const f of findings) {
    const key = findingIdentityKey(f);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(f);
    }
  }
  return result;
}

/**
 * Group findings by extracted session id, counting per RuleID, with
 * non-session paths routed to the `other` bucket. Deduplicates findings
 * before partitioning (via `dedupeFindings`) so both the `bySession` counts
 * and the `other` list reflect the distinct set, keeping the report-builder
 * header count and the `leakVerdictRow` count consistent across the dry-run
 * and real-push paths. Pure: no side effects, no environment reads.
 */
export function partitionFindings(findings: Finding[]): {
  bySession: Map<string, Map<string, number>>;
  other: Finding[];
} {
  const deduped = dedupeFindings(findings);
  const bySession = new Map<string, Map<string, number>>();
  const other: Finding[] = [];
  for (const f of deduped) {
    const m = SESSION_PATH.exec(f.File);
    if (m === null) {
      other.push(f);
      continue;
    }
    const sid = m[1];
    // Defensive type narrowing: the regex guarantees group 1 is captured
    // when m !== null, so this branch is unreachable at runtime. Excluded
    // from coverage rather than contorting tests to fake an impossible state.
    /* c8 ignore next */
    if (sid === undefined) continue;
    let counts = bySession.get(sid);
    if (counts === undefined) {
      counts = new Map<string, number>();
      bySession.set(sid, counts);
    }
    counts.set(f.RuleID, (counts.get(f.RuleID) ?? 0) + 1);
  }
  return { bySession, other };
}

/**
 * Render one `Also found:` row for a non-session ("other"-bucket) finding as
 * `  <File>:<StartLine>  <RuleID>`, where the line number is the manual-scrub
 * locator for the nested transcript. `StartLine` is typed `number` but comes
 * from an unvalidated `parsed as Finding[]` cast over gitleaks subprocess
 * output, so a missing or non-positive value (gitleaks line numbers are
 * 1-indexed) drops the `:<line>` suffix rather than emit a confusing
 * `:undefined` / `:0`.
 */
// Exported only for direct unit tests (dynamic import in push-gitleaks.test.ts).
// fallow-ignore-next-line unused-export
export function formatOtherFinding(f: Finding): string {
  const loc = Number.isInteger(f.StartLine) && f.StartLine > 0 ? `:${f.StartLine}` : '';
  return `  ${f.File}${loc}  ${f.RuleID}`;
}

/**
 * Build the per-finding hint line for an `Also found:` entry. When the
 * File path matches the subagent bucket pattern
 * `shared/projects/<logical>/<id>/...`, the session id is recovered and a
 * `nomad drop-session`/`nomad redact` hint names it explicitly. For paths
 * that do not match (truly non-session files), a manual-review fallback
 * line is returned instead. Pure.
 *
 * @param f The other-bucket finding.
 * @returns A hint line ready for inclusion in the FATAL message.
 */
// Exported only for direct unit tests (dynamic import in push-gitleaks.test.ts).
// fallow-ignore-next-line unused-export
export function otherFindingHint(f: Finding): string {
  const m = SUBAGENT_SESSION_PATH.exec(f.File);
  if (m !== null) {
    const sid = m[1];
    // Defensive: regex guarantees group 1 when m !== null; unreachable at runtime.
    /* c8 ignore next */
    if (sid === undefined) return '  Review with: git diff --cached, then unstage manually.';
    return `  Recover with: nomad drop-session ${sid}  (or: nomad redact ${sid})`;
  }
  return '  Review with: git diff --cached, then unstage manually.';
}

/**
 * Render the `other`-bucket body rows: one `formatOtherFinding` locator line
 * plus its `otherFindingHint` recovery line per finding. Shared by both
 * branches of `buildSessionAwareFatal` (under an `Also found:` header when
 * sessions are also present, or as the primary finding list when they are
 * not). Pure.
 *
 * @param other - Non-session findings.
 * @returns The rendered row lines (two per finding).
 */
function renderOtherFindings(other: Finding[]): string[] {
  const lines: string[] = [];
  for (const f of other) {
    lines.push(formatOtherFinding(f), otherFindingHint(f));
  }
  return lines;
}

/**
 * Build the FATAL message body. Returns the legacy fallback string ONLY when
 * both buckets are empty (no findings at all, a defensive case); otherwise
 * composes the multi-section message.
 *
 * When `bySession` is non-empty: a `gitleaks detected secrets in N session
 * transcript(s).` header, one block per affected session with a
 * `Recover with: nomad drop-session <id>` line, an optional `Also found:`
 * block for non-session paths, and a trailing `After recovery, re-run
 * nomad push.` line. The header carries a single clarifying note that the
 * drop also clears any sibling subagent transcript directory for the
 * session, since those nested paths route to the `other` bucket and are
 * not listed per-session.
 *
 * When `bySession` is empty but `other` is not (e.g. a leak only in a
 * subagent transcript, which matches the deeper subagent path and so never
 * reaches `bySession`): a `gitleaks detected secrets in N location(s):`
 * header followed by the same per-finding locator + recovery-hint lines, so
 * the subagent `nomad drop-session`/`nomad redact` hints are surfaced rather
 * than discarded behind the legacy fallback. Pure.
 *
 * @param bySession - Map of session id to per-RuleID counts (from `partitionFindings`).
 * @param other - Non-session findings for the `Also found:` block.
 * @returns The formatted FATAL message string.
 */
export function buildSessionAwareFatal(
  bySession: Map<string, Map<string, number>>,
  other: Finding[],
): string {
  if (bySession.size === 0 && other.length === 0) return LEGACY_FATAL;
  const lines: string[] = [];
  if (bySession.size > 0) {
    lines.push(
      `gitleaks detected secrets in ${bySession.size} session transcript(s).`,
      "nomad drop-session also clears each session's sibling subagent transcript directory.",
    );
    for (const [sid, counts] of bySession) {
      const summary = [...counts.entries()].map(([rule, n]) => `${rule} (${n})`).join(', ');
      lines.push(
        '',
        `Session ${sid}:`,
        `  ${summary}`,
        `  Recover with: nomad drop-session ${sid}`,
      );
    }
    if (other.length > 0) {
      lines.push('', 'Also found:', ...renderOtherFindings(other));
    }
  } else {
    lines.push(
      `gitleaks detected secrets in ${other.length} location(s):`,
      ...renderOtherFindings(other),
    );
  }
  lines.push('', 'After recovery, re-run nomad push.');
  return lines.join('\n');
}

/**
 * Run the staged gitleaks scan at the end of `cmdPush`, delegating the
 * git-stage + scan mechanism to the shared `scanStagedTree(REPO_HOME, true)`
 * so the push gate and the `--check-shared` preflight cannot drift. The
 * `forwardStreams = true` argument reproduces the prior behavior of writing
 * gitleaks' redacted stderr/stdout so the user sees which file is dirty.
 *
 * On findings, classifies them into session vs non-session paths and throws a
 * session-aware NomadFatal whose message names every affected session id with
 * a `nomad drop-session` recovery hint; non-session-only findings fall back to
 * the legacy FATAL string. When the helper returns `null` (gitleaks exited
 * non-zero but wrote no parseable report: a scanner crash, malformed JSON,
 * missing/locked file, or a non-finding runtime failure, since gitleaks v8.x
 * returns exit 1 for both "leaks found" and runtime errors) it throws a
 * distinct scan-failed FATAL so the operator does not chase a phantom
 * `nomad drop-session` recovery. On the leaks-found path the raw gitleaks
 * streams are suppressed (the session-aware FATAL fully describes the findings).
 * On the scan-failed/null-report path the raw stderr/stdout is forwarded so
 * "Review the gitleaks output above." has something to point at.
 *
 * ENOENT (gitleaks or git absent) propagates from the helper and is mapped to
 * the platform-aware install-hint FATAL. Defense-in-depth: the presence probe
 * at the top of `cmdPush` should have caught a missing binary, but if `cmdPush`
 * ever bypasses the probe (or the user uninstalls gitleaks mid-flow) the same
 * install-hint FATAL fires here.
 */
export function runGitleaksScan(): void {
  let findings: Finding[] | null;
  try {
    findings = scanStagedTree(repoHome(), true);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new NomadFatal(gitleaksInstallHint());
    }
    throw err;
  }
  if (findings === null) {
    throw new NomadFatal(
      'gitleaks scan failed: no parseable JSON report. Review the gitleaks output above.',
    );
  }
  if (findings.length === 0) return;
  const { bySession, other } = partitionFindings(findings);
  throw new NomadFatal(buildSessionAwareFatal(bySession, other));
}
