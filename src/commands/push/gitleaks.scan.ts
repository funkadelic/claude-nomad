/**
 * Owns the gitleaks staged-scan primitives shared by `nomad push`
 * (`runGitleaksScan` in `commands/push/gitleaks.ts`) and the
 * `nomad doctor --check-shared` preflight (`reportCheckShared` in
 * `commands/doctor/checks/shared.ts`): the `Finding` shape, the JSON-report
 * parser `readGitleaksReport`, `scanStagedTree`, and `scanFile`.
 *
 * Split into its own module so adding the git-stage step keeps both
 * `commands/push/gitleaks.ts` and `commands/doctor/checks/shared.ts` under the 200-line
 * cap. `commands/push/gitleaks.ts` re-exports these so existing import sites are
 * unaffected. Dependency flows one way (`commands/push/gitleaks.ts` -> this module, and
 * this module -> `commands/push/gitleaks.config.ts` for `resolveTomlConfig`); no cycle.
 */

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { claudeHome, GITLEAKS_SCAN_TIMEOUT_MS } from '../../core/config.ts';
import { resolveTomlConfig } from './gitleaks.config.ts';
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
 * Scan exec options for a repo dir. An inherited GIT_DIR/GIT_INDEX_FILE/
 * GIT_WORK_TREE (e.g. from a git hook) would stage into the caller's repo
 * instead of `repoDir`, so they are stripped.
 */
function repoExecOpts(repoDir: string): ExecFileSyncOptions {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  return { cwd: repoDir, env, stdio: ['ignore', 'pipe', 'pipe'] };
}

/**
 * Run `git init` then `git <addArgs>` in the repo `opts` point at. The add
 * call drops stdout and raises the stderr buffer: a per-file CRLF warning
 * (Git for Windows default) across thousands of files would overflow the 1 MB
 * default.
 */
function initAndStage(opts: ExecFileSyncOptions, addArgs: string[]): void {
  execFileSync('git', ['init', '-q'], opts);
  execFileSync('git', addArgs, {
    ...opts,
    stdio: ['ignore', 'ignore', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Fallback repo-relative staging path for a local file, used when the caller
 * does not pass the real one. The projects segment stays the encoded dir (push
 * uses the logical name), which the bundled `[^/]+` path patterns still match.
 * Files outside projects/ and skills/ get a fixed neutral name, so a source
 * named like `.gitattributes` is never interpreted by git or gitleaks.
 */
function stagedRelPath(filePath: string): string {
  const abs = resolve(filePath);
  for (const dir of ['projects', 'skills']) {
    const root = join(claudeHome(), dir) + sep;
    if (abs.startsWith(root)) return join('shared', dir, abs.slice(root.length));
  }
  return join('scan', 'file.txt');
}

/** Config overrides for the scratch repo: no CRLF rewrite, no fsmonitor daemon, no hooks. */
const SCRATCH_GIT_CONFIG = [
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=.nomad-no-hooks',
];

/**
 * Exec options for the scratch repo. Every inherited `GIT_*` var is dropped: an
 * object-dir or alternates override would write the unredacted blob outside
 * the private scratch dir. `timeout` bounds each git call and gitleaks.
 */
function scratchExecOpts(repoDir: string, timeoutMs: number): ExecFileSyncOptions {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')),
  );
  return { cwd: repoDir, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs };
}

/**
 * Init the scratch repo and stage its one file byte-for-byte. Repo-level
 * attributes override any global `core.attributesFile` (EOL, LFS filter, ident,
 * encoding), `-f` beats a global exclude, and the final `ls-files` throws when
 * git staged nothing (a `.git` path segment, say), so a skipped file fails
 * closed instead of scanning clean.
 */
function stageScratchCopy(opts: ExecFileSyncOptions, rel: string): void {
  execFileSync('git', ['init', '-q'], opts);
  const info = join(String(opts.cwd), '.git', 'info');
  mkdirSync(info, { recursive: true });
  // `diff` beats an inherited `-diff`/`binary`, which would hide the content from gitleaks.
  writeFileSync(join(info, 'attributes'), '* -text -filter -ident -working-tree-encoding diff\n');
  execFileSync('git', [...SCRATCH_GIT_CONFIG, 'add', '-f', '-A'], {
    ...opts,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const pathspec = rel.split(sep).join('/');
  const ls = [...SCRATCH_GIT_CONFIG, '--literal-pathspecs', 'ls-files', '--error-unmatch'];
  execFileSync('git', [...ls, '--', pathspec], opts);
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
  const gitleaksOpts: ExecFileSyncOptions = { ...opts, timeout: GITLEAKS_SCAN_TIMEOUT_MS };
  try {
    initAndStage(opts, ['add', '-A']);
    execFileSync('gitleaks', args, gitleaksOpts);
    return [];
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer; stdout?: Buffer };
    if (e.code === 'ENOENT') throw err;
    return resolveScanFailure(reportPath, e, forwardStreams);
  } finally {
    if (tempPath !== null) rmSync(tempPath, { recursive: true, force: true });
    rmSync(reportPath, { force: true });
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
  /** Per-call ceiling (ms) for each git call and gitleaks. Default `GITLEAKS_SCAN_TIMEOUT_MS`. */
  timeoutMs?: number;
};

/** Injectable single-file scan seam; `scanFile` is the default implementation. */
export type ScanFn = (filePath: string, opts?: ScanFileOptions) => Finding[] | null;

/**
 * Scan a single non-staged file by staging a copy into a private temp repo at
 * its push-layout path and running `gitleaks protect --staged` with the same
 * `resolveTomlConfig` config as the push gate, so the same allowlists apply
 * (`detect --no-git` chunks large files and misses a keyword-gated match whose
 * keyword is far away). Omits `--config` when no base config exists.
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
 * returns `null` rather than throwing, so callers get a clear scan-failed
 * signal without a stack trace.
 *
 * @param filePath Path to the file to scan (a relative path resolves against the CWD).
 * @param opts Staged path, stream forwarding and timeout; see `ScanFileOptions`.
 * @returns `Finding[]` on success (possibly empty), `null` on scan error.
 */
export function scanFile(filePath: string, opts: ScanFileOptions = {}): Finding[] | null {
  const { forwardStreams = false, timeoutMs = GITLEAKS_SCAN_TIMEOUT_MS } = opts;
  const rel = opts.stagedRel ?? stagedRelPath(filePath);
  const cacheDir = join(homedir(), '.cache', 'claude-nomad');
  mkdirSync(cacheDir, { recursive: true });
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
    // mkdtempSync creates the dir 0o700; the prefix keeps it recognizable.
    reportDir = mkdtempSync(join(cacheDir, `gitleaks-file-${nowTimestamp()}-${process.pid}-`));
    reportPath = join(reportDir, 'report.json');
    // The report sits outside the repo so it is never staged.
    const repo = join(reportDir, 'repo');
    const dest = resolve(repo, rel);
    if (!dest.startsWith(repo + sep)) return null;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(filePath, dest);
    const execOpts = scratchExecOpts(repo, timeoutMs);
    stageScratchCopy(execOpts, relative(repo, dest));
    const args: string[] = [
      'protect',
      '--staged',
      '--report-format=json',
      `--report-path=${reportPath}`,
    ];
    if (toml !== null) args.push('--config', toml);
    execFileSync('gitleaks', args, execOpts);
    return [];
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer; stdout?: Buffer };
    if (e.code === 'ENOENT') return null;
    return resolveScanFailure(reportPath, e, forwardStreams);
  } finally {
    if (tempPath !== null) rmSync(tempPath, { recursive: true, force: true });
    if (reportDir !== undefined) rmSync(reportDir, { recursive: true, force: true });
  }
}
