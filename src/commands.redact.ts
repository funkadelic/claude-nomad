import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_HOME, HOME, HOST, REPO_HOME, type PathMap } from './config.ts';
import { applyRedactions, isRecentlyModified } from './commands.redact.core.ts';
import { type Finding, scanFile } from './push-gitleaks.scan.ts';
import { backupBeforeWrite, freshBackupTs } from './utils.fs.ts';
import { encodePath, readJson } from './utils.json.ts';
import { die, fail, log, NomadFatal } from './utils.ts';
import { acquireLock, releaseLock } from './utils.lockfile.ts';

export type { RedactFinding } from './commands.redact.core.ts';
export {
  applyRedactions,
  appendGitleaksIgnore,
  formatFingerprint,
  isRecentlyModified,
} from './commands.redact.core.ts';

/**
 * Resolve a session id to the live local transcript path on this host via
 * `path-map.json`. Returns the absolute path when it exists on disk, or `null`
 * when the path-map is absent, the session is unmapped on this host, or the
 * local file is already gone. Mirrors `resolveLiveTranscript` from
 * `commands.drop-session.scrub-hint.ts`.
 *
 * @param id Already-validated session id.
 * @returns Absolute live transcript path, or null when unresolvable.
 */
export function resolveLiveTranscript(id: string): string | null {
  try {
    const mapPath = join(REPO_HOME, 'path-map.json');
    if (!existsSync(mapPath)) return null;
    const projects = readJson<PathMap>(mapPath).projects;
    for (const hostMap of Object.values(projects)) {
      const abs = hostMap[HOST];
      if (abs === undefined) continue;
      const live = join(CLAUDE_HOME, 'projects', encodePath(abs), `${id}.jsonl`);
      if (existsSync(live)) return live;
    }
    return null;
  } catch {
    return null;
  }
}

/** Options for the `nomad redact` subcommand. */
export type RedactOpts = {
  /** Session id (validated against `[A-Za-z0-9_-]+`, length 1..128). */
  id: string;
  /** Limit redaction to findings of this gitleaks rule id only. */
  rule?: string;
  /** When true, print the plan and write nothing. */
  dryRun?: boolean;
  /**
   * Findings to redact. When provided (push-time recovery flow), used directly
   * after applying the optional `rule` filter. When omitted (standalone
   * `nomad redact`), `cmdRedact` scans the local transcript with `gitleaks
   * detect --no-git` and uses the resulting findings. A scan error (gitleaks
   * absent or crashed) is reported as a distinct failure, not silently treated
   * as "no findings".
   */
  findings?: readonly {
    StartLine: number;
    Match: string;
    RuleID: string;
  }[];
};

/**
 * Resolve the findings list for a redact operation. When `rawFindings` is
 * provided (push-time recovery), returns them filtered by `rule`. When
 * `rawFindings` is undefined (standalone `nomad redact`), calls `scan` on the
 * local transcript and returns the findings filtered by `rule`, or `null` when
 * the scan itself fails (gitleaks absent or crashed).
 *
 * @param localPath Absolute path to the local transcript.
 * @param rawFindings Pre-supplied findings or undefined to trigger a scan.
 * @param rule Optional rule-id filter applied after findings are resolved.
 * @param scan Injectable scan function (default: `scanFile`).
 * @returns Filtered findings array, or `null` when scan fails.
 */
function resolveRedactFindings(
  localPath: string,
  rawFindings: RedactOpts['findings'],
  rule: string | undefined,
  scan: (p: string) => Finding[] | null,
): readonly { StartLine: number; Match: string; RuleID: string }[] | null {
  const source = rawFindings ?? scan(localPath);
  if (source === null) return null;
  return source.filter((f) => rule === undefined || f.RuleID === rule);
}

/**
 * Non-interactive redaction of a session transcript's secret spans. Rewrites
 * the LOCAL source transcript at `~/.claude/projects/<encoded>/<id>.jsonl` in
 * place (same inode) after backing it up via `backupBeforeWrite`. Refuses to
 * touch a transcript whose mtime is within the live-session threshold (D-06).
 *
 * When `opts.findings` is provided, uses it directly (push-time recovery flow).
 * When `opts.findings` is omitted, scans the local transcript with gitleaks
 * detect via the injected `scan` function. A scan failure (null return) is
 * reported as a distinct error rather than silently treated as "no findings".
 *
 * Validates `id` before any path resolution or lock acquisition. Uses
 * `acquireLock('redact')` with the standard `try/catch(NomadFatal)/finally
 * releaseLock` shape.
 *
 * @param opts Redact options: session id, optional rule filter, optional dry-run, optional findings.
 * @param nowMs Injectable clock for live-session detection (tests inject a fixed value).
 * @param scan Injectable single-file scan function (tests inject a fake; default: `scanFile`).
 */
export function cmdRedact(
  opts: RedactOpts,
  nowMs: () => number = Date.now,
  scan: (p: string) => Finding[] | null = scanFile,
): void {
  const { id, rule, dryRun = false, findings: rawFindings } = opts;

  if (id.length === 0 || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    fail(`invalid session id: ${id}`);
    process.exit(1);
  }
  if (!existsSync(REPO_HOME)) die(`repo not cloned at ${REPO_HOME}`);

  const handle = acquireLock('redact');
  if (handle === null) process.exit(0);
  try {
    const localPath = resolveLiveTranscript(id);
    if (localPath === null || !existsSync(localPath)) {
      fail(`could not resolve local transcript for session ${id} on this host`);
      process.exitCode = 1;
      return;
    }

    const mtimeMs = statSync(localPath).mtimeMs;
    if (isRecentlyModified(mtimeMs, nowMs())) {
      log(
        `session ${id} was modified recently and may be active.\n` +
          '  Refusing to rewrite a potentially live transcript.\n' +
          '  To proceed: wait for the session to end, then re-run nomad redact.\n' +
          `  Or drop from the staged tree: nomad drop-session ${id}\n` +
          '  Or skip this finding during nomad push.',
      );
      return;
    }

    const findings = resolveRedactFindings(localPath, rawFindings, rule, scan);
    if (findings === null) {
      fail(`gitleaks scan failed for session ${id} (is gitleaks installed?)`);
      process.exitCode = 1;
      return;
    }

    if (findings.length === 0) {
      const ruleClause = rule === undefined ? '' : ` for rule ${rule}`;
      log(`no findings${ruleClause} in session ${id}`);
      return;
    }

    if (dryRun) {
      log(
        `dry-run: would redact ${findings.length} finding(s) in ${localPath}\n` +
          findings.map((f) => `  line ${f.StartLine} [${f.RuleID}]`).join('\n'),
      );
      return;
    }

    const backupBase = join(HOME, '.cache', 'claude-nomad', 'backup');
    const ts = freshBackupTs(backupBase);
    backupBeforeWrite(localPath, ts);

    const original = readFileSync(localPath, 'utf8');
    const redacted = applyRedactions(original, findings);
    writeFileSync(localPath, redacted, 'utf8');
    log(`redacted ${findings.length} finding(s) in ${localPath} (backup: ${ts})`);
  } catch (err) {
    /* c8 ignore next 3 */
    if (!(err instanceof NomadFatal)) {
      throw err;
    }
    fail(err.message);
    process.exitCode = 1;
  } finally {
    releaseLock(handle);
  }
}
