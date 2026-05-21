/**
 * Owns the staged gitleaks scan invoked at the end of `cmdPush`.
 *
 * Lives in its own module (split from `push-checks.ts`) so the
 * session-aware FATAL builder (gitleaks JSON parser + per-session message
 * composer) has a clean home while keeping every file under the 200-line
 * cap. `findGitlinks`, `probeGitleaks`, `gitleaksInstallHint`, and
 * `rebaseBeforePush` stay in `push-checks.ts`.
 *
 * `gitleaksInstallHint` is imported from `./push-checks.ts` because the
 * ENOENT branch surfaces the same platform-aware install scaffold whether
 * the missing binary is detected by `probeGitleaks` (top-of-flow) or by
 * this scan (defense-in-depth mid-flow).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { REPO_HOME } from './config.ts';
import { gitleaksInstallHint } from './push-checks.ts';
import { NomadFatal, nowTimestamp } from './utils.ts';

/**
 * Subset of gitleaks 8.x JSON report fields the parser consumes. The
 * report is an array of objects (one per finding) emitted to the
 * `--report-path` file; on clean scans the array is empty.
 */
export type Finding = {
  RuleID: string;
  File: string;
  StartLine: number;
  Match: string;
  Fingerprint: string;
};

/**
 * Captures the session id from a repo-relative POSIX path of the form
 * `shared/projects/<logical>/<sid>.jsonl`. gitleaks emits forward-slash
 * paths regardless of host OS, so the literal works cross-platform.
 * Anchored at both ends + depth-4 segments by construction so deeper
 * paths (e.g., `shared/projects/<logical>/subagents/<id>.jsonl`) fall
 * through to the non-session `other` bucket.
 */
const SESSION_PATH = /^shared\/projects\/[^/]+\/([^/]+)\.jsonl$/;

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
 * nomad push.` line. Pure.
 */
export function buildSessionAwareFatal(
  bySession: Map<string, Map<string, number>>,
  other: Finding[],
): string {
  if (bySession.size === 0) return LEGACY_FATAL;
  const lines: string[] = [];
  lines.push(`gitleaks detected secrets in ${bySession.size} session transcript(s).`);
  for (const [sid, counts] of bySession) {
    const summary = [...counts.entries()].map(([rule, n]) => `${rule} (${n})`).join(', ');
    lines.push('');
    lines.push(`Session ${sid}:`);
    lines.push(`  ${summary}`);
    lines.push(`  Recover with: nomad drop-session ${sid}`);
  }
  if (other.length > 0) {
    lines.push('');
    lines.push('Also found:');
    for (const f of other) {
      lines.push(`  ${f.File}  ${f.RuleID}`);
    }
    lines.push('  Review with: git diff --cached, then unstage manually.');
  }
  lines.push('');
  lines.push('After recovery, re-run nomad push.');
  return lines.join('\n');
}

/**
 * Read and parse the gitleaks JSON report at `reportPath`. Returns the
 * findings array on success, or `null` when the file is missing or the
 * JSON is malformed. Defense-in-depth: an unreadable/invalid report on
 * the failure path must NOT cascade into a parse-error stack trace; the
 * caller falls back to the legacy FATAL string in that case.
 */
function readGitleaksReport(reportPath: string): Finding[] | null {
  try {
    const raw = readFileSync(reportPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as Finding[];
  } catch {
    return null;
  }
}

/**
 * Run gitleaks against the staged index, writing the JSON report to a
 * collision-resistant path under `~/.cache/claude-nomad/`. On non-zero
 * exit, forwards gitleaks' redacted stderr/stdout so the user sees which
 * file is dirty, reads the JSON report, classifies findings into session
 * vs non-session paths, and throws a session-aware NomadFatal whose
 * message names every affected session id with a `nomad drop-session`
 * recovery hint. Non-session-only findings fall back to the legacy FATAL
 * string. The temp report file is removed via `finally` on both success
 * and failure paths.
 *
 * Conditionally passes `--config <REPO_HOME>/.gitleaks.toml` when that file
 * exists at call time. The allowlist suppresses
 * structurally-distinguishable tool-output noise (Sonar issue keys,
 * gitleaks fingerprints, npm audit JSON id-field hashes, coverage line-keys)
 * without weakening real-secret detection. Missing toml = silent fallback
 * to the default gitleaks ruleset (e.g., fresh clones pre-allowlist).
 *
 * ENOENT branch is defense-in-depth: the presence probe at the top of
 * `cmdPush` should have caught a missing binary, but if `cmdPush` ever
 * bypasses the probe (or the user uninstalls gitleaks mid-flow) the same
 * install-hint FATAL fires here.
 */
export function runGitleaksScan(): void {
  const cacheDir = join(homedir(), '.cache', 'claude-nomad');
  mkdirSync(cacheDir, { recursive: true });
  // Disambiguate with pid so the lockfile invariant (one concurrent push
  // per host) is enough to keep the report path unique. The prior
  // freshBackupTs() call checked for a sibling directory named exactly
  // <ts>, which never collides with the file `gitleaks-<ts>.json` being
  // written.
  const reportPath = join(cacheDir, `gitleaks-${nowTimestamp()}-${process.pid}.json`);
  const tomlPath = join(REPO_HOME, '.gitleaks.toml');
  const args: string[] = [
    'protect',
    '--staged',
    '--redact',
    '-v',
    '--report-format=json',
    `--report-path=${reportPath}`,
  ];
  if (existsSync(tomlPath)) args.push('--config', tomlPath);
  try {
    execFileSync('gitleaks', args, {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      status?: number;
      stderr?: Buffer;
      stdout?: Buffer;
    };
    if (e.code === 'ENOENT') throw new NomadFatal(gitleaksInstallHint());
    if (e.stderr) process.stderr.write(e.stderr);
    if (e.stdout) process.stdout.write(e.stdout);
    const findings = readGitleaksReport(reportPath);
    if (findings === null) {
      // gitleaks exited non-zero but no parseable JSON report exists at the
      // expected path. Could be a scanner crash, a malformed report, a
      // missing/locked file, or a non-finding runtime failure (gitleaks v8.x
      // returns exit 1 for both "leaks found" and runtime errors). Tell the
      // operator the scan itself failed so they do not chase a phantom
      // `nomad drop-session` rabbit hole. The stderr/stdout already
      // forwarded above carries the underlying gitleaks output.
      throw new NomadFatal(
        `gitleaks scan failed: no parseable JSON report at ${reportPath} (${e.message}). Review the gitleaks output above.`,
      );
    }
    const { bySession, other } = partitionFindings(findings);
    throw new NomadFatal(buildSessionAwareFatal(bySession, other));
  } finally {
    rmSync(reportPath, { force: true });
  }
}
