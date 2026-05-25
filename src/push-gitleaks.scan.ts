/**
 * Owns the gitleaks staged-scan primitives shared by `nomad push`
 * (`runGitleaksScan` in `./push-gitleaks.ts`) and the
 * `nomad doctor --check-shared` preflight (`reportCheckShared` in
 * `./commands.doctor.check-shared.ts`): the `Finding` shape, the JSON-report
 * parser `readGitleaksReport`, and `scanStagedTree`.
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

import { REPO_HOME } from './config.ts';
import { nowTimestamp } from './utils.ts';

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
 * `gitleaks protect --staged`. Conditionally passes `--config
 * <REPO_HOME>/.gitleaks.toml` when that file exists at call time (missing toml
 * = silent fallback to the default ruleset). Returns `[]` on a clean exit, the
 * parsed `Finding[]` on a non-zero exit with a readable report, or `null` when
 * the report is missing or unparseable (the scan-failed signal). The temp
 * report file is removed in a `finally` on every path. ENOENT (gitleaks or git
 * absent) is re-thrown, not swallowed, so each caller keeps its own
 * missing-binary handling (push -> install-hint FATAL; doctor -> scan-failed
 * FAIL row). All calls use `execFileSync` argv-array form (no shell), the
 * codebase PUSH-04 invariant.
 *
 * `forwardStreams` (default `false`): when `true`, the gitleaks redacted
 * stderr/stdout captured on a non-zero exit is written to the process streams
 * so the operator sees which file is dirty. `runGitleaksScan` passes `true`
 * (byte-identical push behavior); the read-only `--check-shared` preflight
 * leaves it `false` so it never writes to stderr (its scan-failed row carries
 * the error message only, never the streams).
 */
export function scanStagedTree(repoDir: string, forwardStreams = false): Finding[] | null {
  const cacheDir = join(homedir(), '.cache', 'claude-nomad');
  mkdirSync(cacheDir, { recursive: true });
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
  const opts: ExecFileSyncOptions = { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    execFileSync('git', ['init', '-q'], opts);
    execFileSync('git', ['add', '-A'], opts);
    execFileSync('gitleaks', args, opts);
    return [];
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer; stdout?: Buffer };
    if (e.code === 'ENOENT') throw err;
    if (forwardStreams) {
      if (e.stderr) process.stderr.write(e.stderr);
      if (e.stdout) process.stdout.write(e.stdout);
    }
    return readGitleaksReport(reportPath);
  } finally {
    rmSync(reportPath, { force: true });
  }
}
