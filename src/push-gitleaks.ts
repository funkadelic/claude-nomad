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

import { REPO_HOME } from './config.ts';
import { gitleaksInstallHint } from './push-checks.ts';
import { type Finding, scanStagedTree } from './push-gitleaks.scan.ts';
import { NomadFatal } from './utils.ts';

// Re-export the staged-scan primitives (moved to ./push-gitleaks.scan.ts to
// keep both this module and commands.doctor.check-shared.ts under the 200-line
// cap) so existing `from './push-gitleaks.ts'` import sites stay unchanged and
// push + the --check-shared preflight share one scan mechanism.
export { readGitleaksReport } from './push-gitleaks.scan.ts';
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
 * Legacy fallback FATAL emitted when no finding's File matches the session
 * path pattern. Locked verbatim so existing tests covering the non-session
 * path do not regress.
 */
const LEGACY_FATAL =
  'gitleaks detected secrets; review staged changes with git diff --cached and unstage offending files before retry';

/**
 * Group findings by extracted session id, counting per RuleID, with
 * non-session paths routed to the `other` bucket. Pure: no side effects,
 * no environment reads.
 */
export function partitionFindings(findings: Finding[]): {
  bySession: Map<string, Map<string, number>>;
  other: Finding[];
} {
  const bySession = new Map<string, Map<string, number>>();
  const other: Finding[] = [];
  for (const f of findings) {
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
 * Build the FATAL message body. Returns the legacy fallback string when
 * `bySession` is empty (no session matches); otherwise composes the
 * multi-section message: `gitleaks detected secrets in N session
 * transcript(s).` header, one block per affected session with a
 * `Recover with: nomad drop-session <id>` line, an optional `Also found:`
 * block for non-session paths, and a trailing `After recovery, re-run
 * nomad push.` line. The header carries a single clarifying note that the
 * drop also clears any sibling subagent transcript directory for the
 * session, since those nested paths route to the `other` bucket and are
 * not listed per-session. Pure.
 */
export function buildSessionAwareFatal(
  bySession: Map<string, Map<string, number>>,
  other: Finding[],
): string {
  if (bySession.size === 0) return LEGACY_FATAL;
  const lines: string[] = [];
  lines.push(
    `gitleaks detected secrets in ${bySession.size} session transcript(s).`,
    "nomad drop-session also clears each session's sibling subagent transcript directory.",
  );
  for (const [sid, counts] of bySession) {
    const summary = [...counts.entries()].map(([rule, n]) => `${rule} (${n})`).join(', ');
    lines.push('', `Session ${sid}:`, `  ${summary}`, `  Recover with: nomad drop-session ${sid}`);
  }
  if (other.length > 0) {
    lines.push(
      '',
      'Also found:',
      ...other.map((f) => `  ${f.File}:${f.StartLine}  ${f.RuleID}`),
      '  Review with: git diff --cached, then unstage manually.',
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
    findings = scanStagedTree(REPO_HOME, true);
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
