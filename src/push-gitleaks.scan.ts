/**
 * Owns the gitleaks staged-scan primitives shared by `nomad push`
 * (`runGitleaksScan` in `./push-gitleaks.ts`) and the
 * `nomad doctor --check-shared` preflight (`reportCheckShared` in
 * `./commands.doctor.check-shared.ts`): the `Finding` shape, the JSON-report
 * parser `readGitleaksReport`, `scanStagedTree`, and `scanFile`.
 *
 * Split into its own module so adding the git-stage step keeps both
 * `push-gitleaks.ts` and `commands.doctor.check-shared.ts` under the 200-line
 * cap. `push-gitleaks.ts` re-exports all three so existing import sites are
 * unaffected. Dependency flows one way (`push-gitleaks.ts` -> this module);
 * this module imports only `config.ts` and `utils.ts`, so there is no cycle.
 */

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_HOME } from './config.ts';
import { resolveTomlConfig } from './push-gitleaks.config.ts';
import { nowTimestamp } from './utils.fs.ts';

/**
 * Two-tier `.gitleaks.toml` lookup: returns `REPO_HOME/.gitleaks.toml` when
 * present, else the package-bundled copy resolved via `import.meta.url`
 * (always current with the installed binary, critical for standalone repos
 * that have no git update path for the allowlist), else `null`. Callers omit
 * `--config` on a `null` return so gitleaks uses its default ruleset; scanning
 * is never disabled. Exported for reuse in `push-checks.ts` `probeGitleaks`.
 */
export function resolveTomlPath(): string | null {
  const repoToml = join(REPO_HOME, '.gitleaks.toml');
  if (existsSync(repoToml)) return repoToml;
  const bundled = fileURLToPath(new URL('../.gitleaks.toml', import.meta.url));
  return existsSync(bundled) ? bundled : null;
}

/**
 * Subset of gitleaks 8.x JSON report fields the parser consumes. The
 * report is an array of objects (one per finding) emitted to the
 * `--report-path` file; on clean scans the array is empty.
 */
export type Finding = {
  RuleID: string;
  File: string;
  StartLine: number;
  /** 1-indexed character offset where the secret span starts within the raw line. Display and identification metadata only; not used for redaction (which is value-based). */
  StartColumn: number;
  /** 1-indexed inclusive end offset of the secret span within the raw line. Display and identification metadata only; not used for redaction (which is value-based). */
  EndColumn: number;
  Match: string;
  Fingerprint: string;
  /**
   * Human-readable rule description gitleaks bakes into every finding (the
   * matched rule's `description` from its toml). Optional: absent on older
   * gitleaks reports or custom rules with no description, in which case the
   * doctor legend silently omits the entry (graceful degradation, no network).
   */
  Description?: string;
};

/**
 * Read and parse the gitleaks JSON report at `reportPath`. Returns the
 * findings array on success, or `null` when the file is missing or the
 * JSON is malformed. Defense-in-depth: an unreadable/invalid report on
 * the failure path must NOT cascade into a parse-error stack trace; the
 * caller falls back to the legacy FATAL string in that case.
 */
export function readGitleaksReport(reportPath: string): Finding[] | null {
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
 * Scan the staged tree of a git repo with `gitleaks protect --staged`, the
 * single staged-scan mechanism shared by `nomad push` and the
 * `nomad doctor --check-shared` preflight. Routing both through one helper
 * guarantees the preflight cannot miss a secret the push gate would catch:
 * `gitleaks dir` and `gitleaks protect --staged` apply a path-scoped
 * `condition = "AND"` allowlist differently, so a directory scan silently
 * passes content the staged scan flags.
 *
 * In `repoDir`, runs `git init` then `git add -A` (no commit, no user identity:
 * `git add` does not require one), writes the gitleaks JSON report to a
 * collision-resistant path under `~/.cache/claude-nomad/`, and invokes
 * `gitleaks protect --staged`. Passes `--config <toml>` resolved via
 * `resolveTomlConfig`, which layers a user-owned `.gitleaks.overlay.toml` on the
 * two-tier `resolveTomlPath` base by generating a temp `[extend]` config (removed
 * in the `finally`); omits the flag when no base exists so gitleaks uses its
 * default ruleset. Returns `[]` on a clean exit, the
 * parsed `Finding[]` on a non-zero exit with a readable report, or `null` when
 * the report is missing or unparseable (the scan-failed signal). The temp report
 * file and any generated overlay temp-config are removed in a `finally` on every path. ENOENT (gitleaks or git
 * absent) is re-thrown, not swallowed, so each caller keeps its own
 * missing-binary handling (push -> install-hint FATAL; doctor -> scan-failed
 * FAIL row). All calls use `execFileSync` argv-array form (no shell), the
 * codebase PUSH-04 invariant.
 *
 * `forwardStreams` (default `false`): when `true`, the gitleaks redacted
 * stderr/stdout captured on a non-zero exit is written to the process streams
 * ONLY on the scan-crash path (when the report is unparseable or missing, i.e.
 * `readGitleaksReport` returns `null`). On the leaks-found path the report
 * parses to a findings array, the structured caller FATAL fully describes the
 * findings, and the raw streams are suppressed to avoid printing them twice.
 * `runGitleaksScan` passes `true`; the read-only `--check-shared` preflight
 * leaves it `false` so it never writes to streams on any path.
 */
export function scanStagedTree(repoDir: string, forwardStreams = false): Finding[] | null {
  const cacheDir = join(homedir(), '.cache', 'claude-nomad');
  mkdirSync(cacheDir, { recursive: true });
  const reportPath = join(cacheDir, `gitleaks-${nowTimestamp()}-${process.pid}.json`);
  const { path: toml, tempPath } = resolveTomlConfig();
  const args: string[] = [
    'protect',
    '--staged',
    '--redact',
    '-v',
    '--report-format=json',
    `--report-path=${reportPath}`,
  ];
  if (toml !== null) args.push('--config', toml);
  const opts: ExecFileSyncOptions = { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    execFileSync('git', ['init', '-q'], opts);
    execFileSync('git', ['add', '-A'], opts);
    execFileSync('gitleaks', args, opts);
    return [];
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer; stdout?: Buffer };
    if (e.code === 'ENOENT') throw err;
    const report = readGitleaksReport(reportPath);
    if (forwardStreams && report === null) {
      if (e.stderr) process.stderr.write(e.stderr);
      if (e.stdout) process.stdout.write(e.stdout);
    }
    return report;
  } finally {
    if (tempPath !== null) rmSync(tempPath, { recursive: true, force: true });
    rmSync(reportPath, { force: true });
  }
}

/**
 * Scan a single non-staged file with `gitleaks detect --no-git`. Returns a
 * `Finding[]` on success (empty when the file is clean, non-empty when secrets
 * are found), or `null` when the scan itself fails (gitleaks absent, gitleaks
 * crashed, or the report is missing or unparseable).
 *
 * Intentionally does NOT pass `--redact` so that `Finding.Match` and
 * `Finding.Secret` carry the real secret value. Callers that need to perform
 * value-based redaction (e.g. the push recovery `applyRedact` and `cmdRedact`)
 * require the literal match to replace it in the transcript. The temp report
 * file (which contains the real value) is deleted in a `finally` block on every
 * path, and the process streams are never written on the findings path, so the
 * real secret is never emitted to stdout/stderr.
 *
 * Error model mirrors `scanStagedTree`: gitleaks exits non-zero when findings
 * exist (exit 1) or on an internal error (exit 2+). Exit 1 with a parseable
 * report is treated as success-with-findings. Exit 0 means clean. Any error
 * that produces no parseable report (including ENOENT for a missing binary)
 * returns `null` rather than throwing, so callers get a clear scan-failed
 * signal without a stack trace.
 *
 * `forwardStreams` (default `false`): when `true`, stderr/stdout captured on
 * the scan-crash path (report missing or unparseable) is written to the process
 * streams so the caller can surface it. On the findings path the streams are
 * suppressed; the structured `Finding[]` fully describes the result.
 *
 * Passes `--config <toml>` resolved via `resolveTomlConfig` (the
 * `.gitleaks.overlay.toml` merge over the two-tier `resolveTomlPath` base, with a
 * generated temp config cleaned up in the `finally`), mirroring the
 * `scanStagedTree` convention so allow-list entries apply consistently across
 * staged and non-staged scans. Omits the flag when no base config exists.
 *
 * @param filePath Absolute path to the file to scan.
 * @param forwardStreams Forward gitleaks stderr/stdout to process streams on
 *   scan-crash (report missing or unparseable). Default `false`.
 * @returns `Finding[]` on success (possibly empty), `null` on scan error.
 */
export function scanFile(filePath: string, forwardStreams = false): Finding[] | null {
  const cacheDir = join(homedir(), '.cache', 'claude-nomad');
  mkdirSync(cacheDir, { recursive: true });
  const reportPath = join(cacheDir, `gitleaks-file-${nowTimestamp()}-${process.pid}.json`);
  const { path: toml, tempPath } = resolveTomlConfig();
  const args: string[] = [
    'detect',
    '--no-git',
    '--source',
    filePath,
    '--report-format=json',
    `--report-path=${reportPath}`,
  ];
  if (toml !== null) args.push('--config', toml);
  const opts: ExecFileSyncOptions = { stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    execFileSync('gitleaks', args, opts);
    return [];
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer; stdout?: Buffer };
    if (e.code === 'ENOENT') return null;
    const report = readGitleaksReport(reportPath);
    if (forwardStreams && report === null) {
      if (e.stderr) process.stderr.write(e.stderr);
      if (e.stdout) process.stdout.write(e.stdout);
    }
    return report;
  } finally {
    if (tempPath !== null) rmSync(tempPath, { recursive: true, force: true });
    rmSync(reportPath, { force: true });
  }
}
