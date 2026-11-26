/**
 * Owns the gitleaks staged-scan primitives shared by `nomad push`
 * (`runGitleaksScan` in `commands/push/gitleaks.ts`) and the
 * `nomad doctor --check-shared` preflight (`reportCheckShared` in
 * `commands/doctor/checks/shared.ts`): the `Finding` shape, the JSON-report
 * parser `readGitleaksReport`, `scanStagedTree`, and `scanFile`.
 *
 * `commands/push/gitleaks.ts` re-exports these so existing import sites are unaffected.
 * Dependency flows one way (`commands/push/gitleaks.ts` -> this module -> `gitleaks.config.ts`
 * for `resolveTomlConfig` and `gitleaks.stage.ts` for the git staging steps); no cycle.
 */

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { GITLEAKS_SCAN_TIMEOUT_MS, repoHome } from '../../core/config.ts';
import { resolveTomlConfig } from './gitleaks.config.ts';
import {
  forceTextDiff,
  removeScratch,
  repoExecOpts,
  stageAll,
  scratchExecOpts,
  stagedRelPath,
  stageScratchCopy,
  until,
} from './gitleaks.stage.ts';
import { nowTimestamp } from '../../core/utils.fs.ts';

/**
 * Subset of gitleaks 8.x JSON report fields the parser consumes. The
 * report is an array of objects (one per finding) emitted to the
 * `--report-path` file; on clean scans the array is empty.
 */
export type Finding = {
  RuleID: string;
  File: string;
  StartLine: number;
  /**
   * 1-indexed last line of the match. Greater than `StartLine` for a
   * multi-line secret (a PEM block, for example), where a single-line span is
   * only a fragment of the real value. Absent on older gitleaks reports.
   */
  EndLine?: number;
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
  /**
   * The matched secret value. `scanStagedTree` passes `--redact`, so on the
   * push path this arrives as the literal string `REDACTED`, never the real
   * value; `scanFile` (no `--redact`) returns the real value. Absent on older
   * gitleaks reports.
   */
  Secret?: string;
  /**
   * Shannon entropy of the matched secret, computed on the real value even
   * when `Secret`/`Match` are redacted. Absent on older gitleaks reports.
   */
  Entropy?: number;
};

/**
 * Coerce one raw report entry into a `Finding`, or return null when it lacks
 * the fields that make it actionable. Optional string and number fields are
 * defaulted rather than trusted, and numeric ones must be FINITE (a report
 * carrying `1e400` would otherwise pass an Infinity through to consumers): consumers dereference `Match`, `Fingerprint`
 * and `File` directly, and an entry missing one used to surface as a
 * `Cannot read properties of undefined` deep inside the interactive recovery
 * menu, i.e. after `remapPush` had already mutated the repo.
 *
 * `File` and `RuleID` have no safe default: they identify the finding and
 * form its `.gitleaksignore` fingerprint, so an entry without them is
 * rejected rather than repaired.
 *
 * @param entry One element of the parsed report array.
 * @returns The normalized finding, or null when it cannot be trusted.
 */
// Exported only for direct unit tests.
// fallow-ignore-next-line unused-export
export function toFinding(entry: unknown): Finding | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const file = str(e.File);
  const rule = str(e.RuleID);
  if (file === '' || rule === '') return null;
  return {
    RuleID: rule,
    File: file,
    StartLine: num(e.StartLine),
    EndLine: Number.isFinite(e.EndLine) ? (e.EndLine as number) : undefined,
    StartColumn: num(e.StartColumn),
    EndColumn: num(e.EndColumn),
    Match: str(e.Match),
    Fingerprint: str(e.Fingerprint),
    Description: typeof e.Description === 'string' ? e.Description : undefined,
    Secret: typeof e.Secret === 'string' ? e.Secret : undefined,
    Entropy: Number.isFinite(e.Entropy) ? (e.Entropy as number) : undefined,
  };
}

/**
 * Read and parse the gitleaks JSON report at `reportPath`. Returns the
 * findings array on success, or `null` when the file is missing, the JSON is
 * malformed, or any entry fails normalization. Defense-in-depth: an
 * unreadable/invalid report on the failure path must NOT cascade into a
 * parse-error stack trace; the caller falls back to the legacy FATAL string
 * in that case.
 *
 * A single unusable entry fails the WHOLE report rather than being dropped.
 * Silently discarding one would mean pushing whatever secret it described,
 * so the safe direction is to refuse the report and let the caller abort.
 */
function readGitleaksReport(reportPath: string): Finding[] | null {
  try {
    const raw = readFileSync(reportPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const findings: Finding[] = [];
    for (const entry of parsed) {
      const finding = toFinding(entry);
      if (finding === null) return null;
      findings.push(finding);
    }
    return findings;
  } catch {
    return null;
  }
}

/**
 * Shared failure-path handler for the two scan sites. On a gitleaks non-ENOENT
 * error, reads the JSON report (`null` when it is missing/unparseable, or when
 * `reportPath` is `undefined` because the scratch dir was never created), and
 * when `forwardStreams` is set and there is no parseable report, writes the
 * captured stderr/stdout to the process streams plus a one-line cause (failed
 * command, errno, signal) so the caller can surface the diagnostic. Returns the
 * parsed findings, or `null` on a hard scan failure.
 */
function resolveScanFailure(
  reportPath: string | undefined,
  e: { stderr?: Buffer; stdout?: Buffer; message?: string; signal?: string | null },
  forwardStreams: boolean,
): Finding[] | null {
  const report = reportPath === undefined ? null : readGitleaksReport(reportPath);
  if (forwardStreams && report === null) {
    const head = String(e.message).split('\n')[0];
    const signal = e.signal ? ' (' + e.signal + ')' : '';
    process.stderr.write(`scan aborted: ${head}${signal}\n`);
    if (e.stderr) process.stderr.write(e.stderr);
    if (e.stdout) process.stdout.write(e.stdout);
  }
  return report;
}

/**
 * Env for the gitleaks process. gitleaks runs its own `git diff` and reports
 * "no leaks" when that diff fails or is colored, so it skips the global and
 * system git config (`noGlobal` is a path that never exists) and forces color
 * off over the repo's own config.
 */
function gitleaksEnv(opts: ExecFileSyncOptions, noGlobal: string): NodeJS.ProcessEnv {
  return {
    ...opts.env,
    GIT_CONFIG_GLOBAL: noGlobal,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'color.diff',
    GIT_CONFIG_VALUE_0: 'never',
  };
}

/** A `--no-color` gitleaks log line at ERR level, e.g. `11:47AM ERR [git] fatal: ...`. */
const ERR_LOG_LINE = /^\S+ ERR /m;

/**
 * Run gitleaks with its log written to `logPath`, returning the log when it holds an
 * ERR line and null otherwise. gitleaks logs ERR and still exits 0 when its own
 * `git diff` fails (a bad `diff.orderFile` in the repo config, say), having scanned
 * nothing, so a clean exit with an ERR line must not count as clean.
 */
function runGitleaks(args: string[], opts: ExecFileSyncOptions, logPath: string): string | null {
  const fd = openSync(logPath, 'w+', 0o600);
  try {
    execFileSync('gitleaks', [...args, '--no-color'], { ...opts, stdio: ['ignore', 'pipe', fd] });
    const log = readFd(fd).toString('utf8');
    return ERR_LOG_LINE.test(log) ? log : null;
  } catch (err) {
    // stderr goes to the log, so restore it for the crash diagnostic.
    (err as { stderr?: Buffer | null }).stderr ??= readFd(fd);
    throw err;
  } finally {
    closeSync(fd);
  }
}

/** The whole file behind `fd`, read through the fd so the path cannot be swapped in between. */
function readFd(fd: number): Buffer {
  const buf = Buffer.alloc(fstatSync(fd).size);
  readSync(fd, buf, 0, buf.length, 0);
  return buf;
}

/** Scan-failed result for a clean gitleaks exit that logged an error (see `runGitleaks`). */
function loggedErrorFailure(log: string, forwardStreams: boolean): Finding[] | null {
  const e = { message: 'gitleaks logged an error, so a clean result cannot be trusted' };
  return resolveScanFailure(undefined, { ...e, stderr: Buffer.from(log) }, forwardStreams);
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
 * two-tier `resolveTomlPath` base by generating a temp config that `extend`s it (removed
 * in the `finally`); omits the flag when no base exists so gitleaks uses its
 * default ruleset. Returns `[]` on a clean exit, the
 * parsed `Finding[]` on a non-zero exit with a readable report, or `null` when
 * the report is missing or unparseable (the scan-failed signal). The temp report
 * file and any generated overlay temp-config are removed in a `finally` on every path. ENOENT (gitleaks or git
 * absent) is re-thrown, not swallowed, so each caller keeps its own
 * missing-binary handling (push -> install-hint FATAL; doctor -> scan-failed
 * FAIL row). All calls use `execFileSync` argv-array form (no shell), matching
 * the no-shell invariant applied consistently across the codebase.
 *
 * `forwardStreams` (default `false`): when `true`, the failure cause and the
 * captured stderr (gitleaks runs without `-v`, so stdout carries no findings)
 * are written to the process streams ONLY on the scan-crash path (when the
 * report is unparseable or missing, i.e. `readGitleaksReport` returns `null`).
 * On the leaks-found path the structured caller FATAL fully describes the
 * findings and the streams are suppressed.
 * `runGitleaksScan` passes `true`; the read-only `--check-shared` preflight
 * leaves it `false` so it never writes to streams on any path.
 *
 * `gitleaks detect --no-git` also diverges from this mechanism (it chunks large
 * files and misses a keyword-gated match whose keyword is far away), which is
 * why `scanFile` uses the same staged scan.
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
    // No `-v`: the report file carries every finding, and verbose stdout past
    // the 1 MB `execFileSync` buffer kills gitleaks before it writes the report.
    '--report-format=json',
    `--report-path=${reportPath}`,
  ];
  if (toml !== null) args.push('--config', toml);
  const opts = repoExecOpts(repoDir);
  const gitleaksOpts: ExecFileSyncOptions = {
    ...opts,
    env: gitleaksEnv(opts, `${reportPath}.no-gitconfig`),
    timeout: GITLEAKS_SCAN_TIMEOUT_MS,
  };
  let restore = (): void => undefined;
  try {
    execFileSync('git', ['init', '-q'], opts);
    restore = forceTextDiff(opts);
    stageAll(opts);
    const errLog = runGitleaks(args, gitleaksOpts, `${reportPath}.log`);
    return errLog === null ? [] : loggedErrorFailure(errLog, forwardStreams);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer; stdout?: Buffer };
    if (e.code === 'ENOENT') throw err;
    return resolveScanFailure(reportPath, e, forwardStreams);
  } finally {
    restore();
    if (tempPath !== null) rmSync(tempPath, { recursive: true, force: true });
    rmSync(reportPath, { force: true });
    rmSync(`${reportPath}.log`, { force: true });
  }
}

/** Options for `scanFile`. */
export type ScanFileOptions = {
  /**
   * Repo-relative path push stages the file at (`shared/projects/<logical>/...`),
   * so path-scoped allowlists match exactly as on the push gate. Derived from
   * the local path when absent.
   */
  stagedRel?: string;
  /** Forward captured stderr/stdout on a scan crash (no parseable report). */
  forwardStreams?: boolean;
  /** Ceiling (ms) for the whole scan, shared by the git calls and gitleaks. Default `GITLEAKS_SCAN_TIMEOUT_MS`. */
  timeoutMs?: number;
};

/** Injectable single-file scan seam; `scanFile` is the default implementation. */
export type ScanFn = (filePath: string, opts?: ScanFileOptions) => Finding[] | null;

/**
 * Scan a single non-staged file by staging a copy into a private temp repo at
 * its push-layout path and running `gitleaks protect --staged` with the same
 * `resolveTomlConfig` config as the push gate, plus the sync repo's
 * `.gitleaksignore` when `stagedRel` is given, so the same allowlists and
 * Allowed fingerprints apply (`detect --no-git`
 * chunks large files and misses a keyword-gated match whose keyword is far
 * away). Omits `--config` when no base config exists.
 *
 * Intentionally does NOT pass `--redact` so that `Finding.Match` and
 * `Finding.Secret` carry the real secret value. Callers that need to perform
 * value-based redaction (e.g. the push recovery `applyRedact` and `cmdRedact`)
 * require the literal match to replace it in the transcript. Because this report
 * holds real secret values (unlike `scanStagedTree`, which passes `--redact`),
 * it is written into an owner-only (`0o700`) `mkdtempSync` scratch dir rather
 * than the shared `~/.cache/claude-nomad/` (mode ~`0o755`), so the transient
 * report, the file copy and the repo objects are never world-readable while
 * they exist. The whole scratch dir is
 * removed in a `finally` block on every path, and the process streams are never
 * written on the findings path, so the real secret is never emitted to
 * stdout/stderr.
 *
 * Error model mirrors `scanStagedTree`: gitleaks exits non-zero when findings
 * exist (exit 1) or on an internal error (exit 2+). Exit 1 with a parseable
 * report is treated as success-with-findings. Exit 0 means clean. Any other
 * failure (git or gitleaks missing, crashed or timed out, the file not staged,
 * a `stagedRel` outside the scratch repo, or a missing/unparseable report)
 * returns `null`, so callers get a clear scan-failed signal without a stack
 * trace. The one throw is `resolveTomlConfig`'s `NomadFatal` for an unsafe
 * overlay, which carries the fix the user needs.
 *
 * @param filePath Path to the file to scan (a relative path resolves against the CWD).
 * @param opts Staged path, stream forwarding and timeout; see `ScanFileOptions`.
 * @returns `Finding[]` on success (possibly empty), `null` on scan error.
 */
export function scanFile(filePath: string, opts: ScanFileOptions = {}): Finding[] | null {
  const { forwardStreams = false, timeoutMs = GITLEAKS_SCAN_TIMEOUT_MS } = opts;
  const deadline = Date.now() + timeoutMs;
  const rel = opts.stagedRel ?? stagedRelPath(filePath);
  const cacheDir = join(homedir(), '.cache', 'claude-nomad');
  // Resolve the config (which may generate its own temp file) BEFORE creating
  // the scratch dir: if resolveTomlConfig throws, no reportDir exists yet, so
  // the finally below cannot orphan an empty scratch dir under the cache.
  const { path: toml, tempPath } = resolveTomlConfig();
  // Create the scratch report dir INSIDE the try so a mkdtempSync failure still
  // runs the finally and cleans up the temp config resolveTomlConfig may have
  // generated (tempPath); otherwise that artifact would be orphaned. reportDir/
  // reportPath stay `undefined` until the dir exists, so the finally and the
  // catch's report read both guard on that.
  let reportDir: string | undefined;
  let reportPath: string | undefined;
  try {
    mkdirSync(cacheDir, { recursive: true });
    // mkdtempSync creates the dir 0o700; the prefix keeps it recognizable.
    reportDir = mkdtempSync(join(cacheDir, `gitleaks-file-${nowTimestamp()}-${process.pid}-`));
    reportPath = join(reportDir, 'report.json');
    // The report sits outside the repo so it is never staged.
    const repo = join(reportDir, 'repo');
    const dest = resolve(repo, rel);
    if (!dest.startsWith(repo + sep)) return null;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(filePath, dest);
    const execOpts = scratchExecOpts(repo);
    stageScratchCopy(execOpts, relative(repo, dest), deadline);
    const args: string[] = [
      'protect',
      '--staged',
      '--report-format=json',
      `--report-path=${reportPath}`,
    ];
    if (toml !== null) args.push('--config', toml);
    // Push-layout files only: the push gate's ignore file, so Redact leaves Allowed values alone.
    // Resolved because gitleaks runs inside the scratch repo, where a relative NOMAD_REPO breaks.
    if (opts.stagedRel !== undefined) {
      args.push(`--gitleaks-ignore-path=${resolve(repoHome(), '.gitleaksignore')}`);
    }
    const env = gitleaksEnv(execOpts, join(reportDir, 'no-gitconfig'));
    const errLog = runGitleaks(args, { ...until(execOpts, deadline), env }, `${reportPath}.log`);
    return errLog === null ? [] : loggedErrorFailure(errLog, forwardStreams);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer; stdout?: Buffer };
    if (e.code === 'ENOENT') return null;
    return resolveScanFailure(reportPath, e, forwardStreams);
  } finally {
    if (tempPath !== null) rmSync(tempPath, { recursive: true, force: true });
    if (reportDir !== undefined) removeScratch(reportDir);
  }
}
