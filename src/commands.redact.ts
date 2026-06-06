import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { backupBase, claudeHome, HOST, repoHome, type PathMap } from './config.ts';
import { isRecentlyModified } from './commands.redact.core.ts';
import {
  applySubtreeRedactions,
  listSubtreeFiles,
  newestSubtreeMtimeMs,
} from './commands.redact.subtree.ts';
import { type Finding, scanFile } from './push-gitleaks.scan.ts';
import { freshBackupTs } from './utils.fs.ts';
import { encodePath, readJson } from './utils.json.ts';
import { die, fail, log, NomadFatal } from './utils.ts';
import { acquireLock, releaseLock } from './utils.lockfile.ts';

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
    const mapPath = join(repoHome(), 'path-map.json');
    if (!existsSync(mapPath)) return null;
    const projects = readJson<PathMap>(mapPath).projects;
    const claude = claudeHome();
    for (const hostMap of Object.values(projects)) {
      const abs = hostMap[HOST];
      if (abs === undefined) continue;
      const live = join(claude, 'projects', encodePath(abs), `${id}.jsonl`);
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
 * Return findings filtered by `rule`. Uses `rawFindings` when provided
 * (push-time recovery path), else calls `scan`; returns null on scan failure.
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
 * Non-interactive redaction of a session transcript. Rewrites the main
 * `<id>.jsonl` and every file under `<id>/` (subagents/, tool-results/, etc.)
 * after backing each up. Refuses live sessions (mtime guard evaluated across
 * the whole subtree). Subtree files are always scanned; `opts.findings` drives
 * only the main file (push-time recovery path).
 *
 * @param opts Session id, optional rule filter, optional dry-run, optional pre-supplied findings.
 * @param nowMs Injectable clock (default: `Date.now`).
 * @param scan Injectable scan function (default: `scanFile`).
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
  // Resolve roots once per command invocation (T-45-02 TOCTOU mitigation).
  const repo = repoHome();
  const backup = backupBase();
  if (!existsSync(repo)) die(`repo not cloned at ${repo}`);

  const handle = acquireLock('redact');
  if (handle === null) process.exit(0);
  try {
    const localPath = resolveLiveTranscript(id);
    if (localPath === null || !existsSync(localPath)) {
      fail(`could not resolve local transcript for session ${id} on this host`);
      process.exitCode = 1;
      return;
    }

    // Live-session guard: evaluate across the whole subtree (main + all files under <id>/).
    const sessionDir = join(dirname(localPath), id);
    const subtreeFiles = listSubtreeFiles(sessionDir);
    const subtreeMtime = newestSubtreeMtimeMs(localPath, subtreeFiles, (p) => statSync(p).mtimeMs);
    if (isRecentlyModified(subtreeMtime, nowMs())) {
      log(
        `session ${id} was modified recently and may be active.\n` +
          '  Refusing to rewrite a potentially live transcript.\n' +
          '  To proceed: wait for the session to end, then re-run nomad redact.\n' +
          `  Or drop from the staged tree: nomad drop-session ${id}\n` +
          '  Or skip this finding during nomad push.',
      );
      return;
    }

    const mainFindings = resolveRedactFindings(localPath, rawFindings, rule, scan);
    if (mainFindings === null) {
      fail(`gitleaks scan failed for session ${id} (is gitleaks installed?)`);
      process.exitCode = 1;
      return;
    }

    const ts = freshBackupTs(backup);
    const { total: totalCount, dirty } = applySubtreeRedactions(
      localPath,
      mainFindings,
      subtreeFiles,
      rule,
      ts,
      scan,
      dryRun,
    );

    if (totalCount === 0) {
      const ruleClause = rule === undefined ? '' : ` for rule ${rule}`;
      log(`no findings${ruleClause} in session ${id}`);
      return;
    }

    if (dryRun) {
      const lines = dirty
        .flatMap((e) => e.findings.map((f) => `  ${e.path}  line ${f.StartLine} [${f.RuleID}]`))
        .join('\n');
      log(`dry-run: would redact ${totalCount} finding(s) in session ${id}\n${lines}`);
      return;
    }

    log(`redacted ${totalCount} finding(s) in ${localPath} (backup: ${ts})`);
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
