/**
 * Shared leak-scan verdict vocabulary for `cmdPush`. Both the dry-run preview
 * (`previewPushLeaks` in `./push-preview.ts`) and the real-push scan
 * (`scanPushVerdict` here) produce the same structured `LeakVerdict` so the
 * one-line Leak scan row rendered inside the grouped tree cannot drift between
 * the two paths. The multi-line `recovery` block (the `buildSessionAwareFatal`
 * body) is printed by `cmdPush` BELOW the rendered tree on a leak.
 *
 * On a real push the scan still aborts the run: `cmdPush` renders the tree with
 * the ✗ verdict row, then throws a `NomadFatal` carrying `recovery` so the
 * existing catch prints the recovery block and sets a non-zero exit. The
 * dry-run path never throws; it only sets `process.exitCode = 1`.
 */

import { failGlyph, green, okGlyph, red } from './color.ts';
import { gitleaksInstallHint } from './push-checks.ts';
import {
  type Finding,
  buildSessionAwareFatal,
  partitionFindings,
  scanStagedTree,
} from './push-gitleaks.ts';

/**
 * Structured leak-scan verdict.
 *
 * - `leak`: `true` only when findings were present (a scan crash is surfaced
 *   via a ✗ `verdictRow` but is NOT a leak, so the dry-run path does not throw).
 * - `verdictRow`: the rendered one-line Leak scan row (glyph embedded).
 * - `recovery`: the `buildSessionAwareFatal` body on a leak, else `null`.
 * - `findings`: the raw findings array from the scan. Non-empty on a leak verdict;
 *   empty (`[]`) on a clean scan, scan crash, or scan error. Carries the
 *   `StartColumn`/`EndColumn` spans that the recovery flow uses for span rewrite.
 */
export type LeakVerdict = {
  leak: boolean;
  verdictRow: string;
  recovery: string | null;
  findings: Finding[];
};

/** Rendered clean Leak scan row (no findings). */
export const noLeaksRow = (): string => `${green(okGlyph)} no leaks`;

/** Rendered ✗ Leak scan row (caller supplies the message text). */
export const failRow = (text: string): string => `${red(failGlyph)} ${text}`;

/**
 * Build the one-line ✗ Leak scan verdict row for a non-empty findings set,
 * naming the affected session count. Falls back to the raw finding count when
 * no finding matches the session-path pattern. Pure.
 *
 * @param findings - The non-empty findings array.
 * @returns The rendered ✗ verdict row.
 */
export function leakVerdictRow(findings: Finding[]): string {
  const { bySession } = partitionFindings(findings);
  const n = bySession.size > 0 ? bySession.size : findings.length;
  return failRow(`gitleaks detected secrets in ${n} session transcript(s)`);
}

/**
 * Build the leak verdict for a non-empty findings set: the ✗ verdict row plus
 * the `buildSessionAwareFatal` recovery body. Pure (no `process.exitCode`
 * side effect; callers own that). Shared by the dry-run and real-push paths so
 * the verdict row and recovery body cannot diverge.
 *
 * @param findings - The non-empty findings array.
 * @returns A `leak=true` verdict carrying the ✗ row and recovery body.
 */
function leakFound(findings: Finding[]): LeakVerdict {
  const { bySession, other } = partitionFindings(findings);
  return {
    leak: true,
    verdictRow: leakVerdictRow(findings),
    recovery: buildSessionAwareFatal(bySession, other),
    findings,
  };
}

/**
 * Map a `scanStagedTree` result to a structured `LeakVerdict`, applying the
 * shared side effect (`process.exitCode = 1` on findings or a scan crash). A
 * `null` report (scan crash) yields a ✗ scan-failed row with `recovery=null`
 * and is NOT classified as a `leak` (so the dry-run path neither throws nor
 * offers a phantom drop-session hint). An empty array yields the clean
 * `✓ no leaks` row. Non-empty findings yield the ✗ verdict row plus the
 * `buildSessionAwareFatal` recovery body.
 *
 * @param findings - Output of `scanStagedTree`, or `null` on scan crash.
 * @returns The structured verdict for the Leak scan section.
 */
export function verdictFromFindings(findings: Finding[] | null): LeakVerdict {
  if (findings === null) {
    process.exitCode = 1;
    return {
      leak: false,
      verdictRow: failRow('scan failed, no parseable report'),
      recovery: null,
      findings: [],
    };
  }
  if (findings.length === 0) {
    return { leak: false, verdictRow: noLeaksRow(), recovery: null, findings: [] };
  }
  process.exitCode = 1;
  return leakFound(findings);
}

/**
 * Verdict for a scan that threw before producing a report (e.g. gitleaks/git
 * absent on the dry-run path). Sets `process.exitCode = 1` and yields a ✗ row
 * with `recovery=null`. Does not mark `leak` so the caller never throws.
 *
 * @param text - The ✗ row message text.
 * @returns The structured scan-error verdict.
 */
export function verdictScanError(text: string): LeakVerdict {
  process.exitCode = 1;
  return { leak: false, verdictRow: failRow(text), recovery: null, findings: [] };
}

/**
 * Run the real-push staged gitleaks scan (the same `scanStagedTree(REPO_HOME,
 * true)` the push gate uses) and RETURN a structured `LeakVerdict` instead of
 * throwing. This lets `cmdPush` render the grouped tree with the ✗ Leak scan
 * row BEFORE re-raising the FATAL so the recovery block prints below the tree.
 *
 * On findings: `leak=true`, `verdictRow` is the ✗ row, `recovery` is the
 * `buildSessionAwareFatal` body. On a clean scan: `✓ no leaks`. On a null
 * report (scanner crash, malformed JSON): a ✗ scan-failed verdict with
 * `recovery` set to the same scan-failed FATAL string `runGitleaksScan` would
 * have thrown, so `cmdPush` still aborts. ENOENT (gitleaks/git absent) maps to
 * the platform-aware install-hint FATAL as `recovery` with a ✗ row.
 *
 * @param repo Repo root resolved once by the calling command.
 * @returns The structured verdict for the real-push Leak scan section.
 */
export function scanPushVerdict(repo: string): LeakVerdict {
  let findings: Finding[] | null;
  try {
    findings = scanStagedTree(repo, true);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        leak: true,
        verdictRow: failRow('gitleaks not found'),
        recovery: gitleaksInstallHint(),
        findings: [],
      };
    }
    throw err;
  }
  if (findings === null) {
    return {
      leak: true,
      verdictRow: failRow('scan failed, no parseable report'),
      recovery: 'gitleaks scan failed: no parseable JSON report. Review the gitleaks output above.',
      findings: [],
    };
  }
  if (findings.length === 0) {
    return { leak: false, verdictRow: noLeaksRow(), recovery: null, findings: [] };
  }
  return leakFound(findings);
}
