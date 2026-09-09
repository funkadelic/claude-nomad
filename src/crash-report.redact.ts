/**
 * Best-effort, value-based secret redaction for crash-report text. Reuses
 * the existing `scanFile` (single-file gitleaks scan) and `applyRedactions`
 * verbatim: this is the third call site of the same scan-then-redact shape
 * already used by push leak recovery and `nomad redact`
 * (`./commands.redact.subtree.ts`), so no new secret-detection logic is
 * introduced here.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyRedactions } from './commands/redact/core.ts';
import { scanFile } from './commands/push/gitleaks.scan.ts';

/**
 * Wall-clock ceiling (milliseconds) for the gitleaks scan invoked from the
 * crash path. Mirrors the `FETCH_TIMEOUT_MS = 3_000` fail-fast precedent in
 * `http-fetch.ts` and deliberately does NOT reuse the 900s
 * `GITLEAKS_SCAN_TIMEOUT_MS` push-scan ceiling: a wedged or slow gitleaks
 * invocation must not hang process exit during a crash, so the crash path
 * gets its own short, dedicated timeout independent of the push ceiling.
 */
export const CRASH_SCAN_TIMEOUT_MS = 3_000;

/**
 * Advisory line appended to the report text when the value-based gitleaks
 * scan does not run (binary absent, crashed, or timed out). The
 * structurally-scrubbed text is still returned unchanged otherwise, so the
 * crash report is never withheld just because gitleaks is unavailable.
 */
const SCAN_UNAVAILABLE_ADVISORY =
  '\n\n[gitleaks value-based scan unavailable; only structural redaction applied. ' +
  'Review before sharing this file publicly.]\n';

/**
 * Redact secret values from `text` using the same gitleaks-scan-then-
 * `applyRedactions` mechanism the push leak recovery and `nomad redact`
 * paths already use. Writes `text` to a throwaway 0o600 temp file under a
 * fresh `mkdtempSync` scratch directory, scans it with `scan` (defaults to
 * the real `scanFile`, bounded by `CRASH_SCAN_TIMEOUT_MS` so a wedged
 * gitleaks cannot hang the crash path), and applies `applyRedactions` to any
 * findings.
 *
 * Never throws: ANY failure degrades to the same advisory fallback. A `null`
 * scan return (gitleaks absent, crashed, or timed out) OR an exception at any
 * step (scratch-dir creation, temp-file write, the scan itself, or
 * `applyRedactions`) returns the structurally-scrubbed `text` unchanged plus
 * one appended advisory line, so a redaction failure can never withhold the
 * crash report the way a re-throw into the fail-safe writer would. The
 * scratch directory is removed in a `finally` block on every path.
 *
 * @param text Structurally-scrubbed crash-report text to redact.
 * @param scan Injectable scan function; defaults to the real `scanFile` so
 *   unit tests can supply a fake without invoking a real gitleaks binary.
 * @returns The value-redacted text, or `text` plus an advisory line when the
 *   scan returned null or any step failed.
 */
export function redactWithGitleaks(text: string, scan: typeof scanFile = scanFile): string {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'nomad-crash-scan-'));
    const tmp = join(dir, 'crash.txt');
    writeFileSync(tmp, text, { mode: 0o600 });
    const findings = scan(tmp, false, CRASH_SCAN_TIMEOUT_MS);
    if (findings === null) return text + SCAN_UNAVAILABLE_ADVISORY;
    return applyRedactions(text, findings);
  } catch {
    // Any thrown failure degrades to structural-only text plus the advisory,
    // matching the `null`-scan path: never withhold the report.
    return text + SCAN_UNAVAILABLE_ADVISORY;
  } finally {
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Cleanup is best-effort on the crash path.
      }
    }
  }
}
