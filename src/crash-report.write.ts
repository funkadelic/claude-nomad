/**
 * Fail-safe crash-report writer: persists a crash report to a self-pruning,
 * host-local cache directory and prints a short banner. Also owns the
 * top-level `handleCrash` orchestrator that ties together
 * `buildCrashReport` (`./crash-report.ts`) and `redactWithGitleaks`
 * (`./crash-report.redact.ts`) into one fail-safe entry point the process's
 * `uncaughtException`/`unhandledRejection` handlers can call without any
 * risk of re-throwing back into the process.
 */

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { crashDir, HOST, home } from './config.ts';
import { buildCrashReport } from './crash-report.ts';
import { redactWithGitleaks } from './crash-report.redact.ts';
import { prunableByCount } from './commands.clean.ts';
import { nowTimestamp } from './utils.fs.ts';
import { fail, item } from './utils.ts';

/**
 * Number of newest crash report files retained under `crashDir()`. This is
 * the ONLY bounding applied to the crash directory: unlike `~/.cache/
 * claude-nomad/backup/`, there is no `nomad clean --crash` flag (deliberately
 * out of scope for this phase; the self-prune on every write is sufficient
 * bounding for a low-frequency, small-file directory).
 */
export const CRASH_RETENTION_KEEP = 20;

/** A crash report file entry, tagged with its modification time. */
export type CrashFile = { name: string; mtimeMs: number };

/**
 * Enumerate crash report files directly under `dir`, newest-first. Never
 * throws: a missing (or otherwise unreadable) directory yields `[]`.
 *
 * @param dir Absolute path to the crash directory; defaults to `crashDir()`.
 * @returns Crash file descriptors `{ name, mtimeMs }`, newest first.
 */
export function listCrashFiles(dir: string = crashDir()): CrashFile[] {
  try {
    return readdirSync(dir)
      .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

/**
 * Prune `dir` down to the newest `keep` crash files, reusing the generic
 * `prunableByCount` retention filter (`./commands.clean.ts`). Each prune
 * target is unlinked individually; a per-file unlink error (e.g. the file
 * was already removed concurrently) is swallowed so pruning stays
 * best-effort and never surfaces to the caller.
 *
 * @param dir Absolute path to the crash directory.
 * @param keep Number of newest files to retain; defaults to `CRASH_RETENTION_KEEP`.
 */
export function pruneCrashDir(dir: string, keep: number = CRASH_RETENTION_KEEP): void {
  const files = listCrashFiles(dir);
  const targets = prunableByCount(files, keep);
  for (const name of targets) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Best-effort: a concurrent removal or transient fs error must not
      // abort the write path this prune runs alongside.
    }
  }
}

/**
 * Persist `text` as a new crash report file. Creates `dir` (default
 * `crashDir()`) at `0o700` if missing, writes the report at `0o600` under a
 * `crash-<timestamp>-<pid>.txt` filename, then prunes `dir` down to the
 * newest `CRASH_RETENTION_KEEP` files.
 *
 * @param text The (already redacted) crash report text.
 * @param dir Absolute path to the crash directory; defaults to `crashDir()`.
 * @returns The absolute path of the file just written.
 */
export function writeCrashReport(text: string, dir: string = crashDir()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `crash-${nowTimestamp()}-${process.pid}.txt`);
  writeFileSync(path, text, { mode: 0o600 });
  pruneCrashDir(dir);
  return path;
}

/** Options accepted by {@link handleCrash}. */
export type HandleCrashOptions = {
  /** The running nomad version, included in the report. */
  version: string;
  /** `process.platform`, or an injected value in tests. */
  platform: string;
  /** URL suggested in the banner for filing a bug report (e.g. `pkg.bugs.url`). */
  issuesUrl: string;
  /** Injectable redaction seam; defaults to the real `redactWithGitleaks`. */
  redact?: typeof redactWithGitleaks;
  /** Injectable writer seam; defaults to the real `writeCrashReport`. */
  write?: typeof writeCrashReport;
  /** Injectable timestamp source; defaults to `() => new Date().toISOString()`. */
  now?: () => string;
};

/**
 * Fail-safe orchestrator: builds, redacts, writes, and announces a crash
 * report for an unexpected (non-`NomadFatal`) error. Intended to be called
 * from the process-level `uncaughtException`/`unhandledRejection` handlers
 * and the top-level dispatch `catch`.
 *
 * The ENTIRE body runs inside a single `try/catch` with a no-throw
 * contract: any failure at any step (report building, redaction, writing)
 * is caught and degrades to a single minimal `fail()` line, so `handleCrash`
 * can never itself throw back into the process. A throw here would risk
 * re-entering `uncaughtException` in a loop. `handleCrash` does not call
 * `process.exit`; the caller owns the exit code.
 *
 * @param err The value thrown or passed to the process-level listener.
 * @param argv The invoking process argv (or a subset).
 * @param opts See {@link HandleCrashOptions}.
 */
export function handleCrash(err: unknown, argv: readonly string[], opts: HandleCrashOptions): void {
  const redact = opts.redact ?? redactWithGitleaks;
  const write = opts.write ?? writeCrashReport;
  const now = opts.now ?? (() => new Date().toISOString());
  try {
    const report = buildCrashReport({
      err,
      argv,
      version: opts.version,
      platform: opts.platform,
      timestamp: now(),
      homeDir: home(),
      hostLabel: HOST,
    });
    const redacted = redact(report);
    const path = write(redacted);
    fail('nomad hit an unexpected error. This looks like a bug, not something you did wrong.');
    item(`Crash report written to: ${path}`);
    item(`Please consider reporting it at: ${opts.issuesUrl}`);
  } catch {
    fail('nomad hit an unexpected error and could not write a crash report.');
  }
}
