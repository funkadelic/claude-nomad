import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BACKUP_BASE, CLAUDE_HOME, HOST, REPO_HOME, type PathMap } from './config.ts';
import { applyRedactions, isRecentlyModified } from './commands.redact.core.ts';
import { listSubagentTranscripts, newestSubtreeMtimeMs } from './commands.redact.subtree.ts';
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

/** @internal shared finding shape */
type FileFinding = { StartLine: number; Match: string; RuleID: string };

/**
 * Redact the main transcript and every subagent transcript. Resolves findings
 * for each agent via `resolveRedactFindings` (honoring `rule`); silently skips
 * agents whose scan returns null or []. Returns total finding count across all
 * files; backs up and rewrites each dirty file unless `dryRun` is true.
 *
 * @param mainPath Absolute path to the main `<sid>.jsonl`.
 * @param mainFindings Pre-resolved findings for the main file.
 * @param agentPaths Absolute paths to each `agent-*.jsonl`.
 * @param rule Optional rule-id filter for agent scans.
 * @param ts Backup timestamp for `backupBeforeWrite`.
 * @param scan Injectable scan function.
 * @param dryRun When true, skip writes and return the count only.
 * @returns Total finding count across the whole subtree.
 */
function redactLiveSubtree(
  mainPath: string,
  mainFindings: readonly FileFinding[],
  agentPaths: string[],
  rule: string | undefined,
  ts: string,
  scan: (p: string) => Finding[] | null,
  dryRun: boolean,
): number {
  const dirty: { path: string; findings: readonly FileFinding[] }[] = [];
  if (mainFindings.length > 0) dirty.push({ path: mainPath, findings: mainFindings });
  for (const agentPath of agentPaths) {
    const found = resolveRedactFindings(agentPath, undefined, rule, scan);
    if (found !== null && found.length > 0) dirty.push({ path: agentPath, findings: found });
  }
  const total = dirty.reduce((n, e) => n + e.findings.length, 0);
  if (dryRun || total === 0) return total;
  for (const { path: filePath, findings } of dirty) {
    backupBeforeWrite(filePath, ts);
    writeFileSync(filePath, applyRedactions(readFileSync(filePath, 'utf8'), findings), 'utf8');
  }
  return total;
}

/**
 * Non-interactive redaction of a session transcript. Rewrites the main
 * `<id>.jsonl` and every `subagents/agent-*.jsonl` in the same session
 * directory after backing each up. Refuses live sessions (mtime guard
 * evaluated across the whole subtree). Agent files are always scanned;
 * `opts.findings` drives only the main file (push-time recovery path).
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

    // Live-session guard: evaluate across the whole subtree (main + subagents).
    const sessionDir = join(dirname(localPath), id);
    const agentPaths = listSubagentTranscripts(sessionDir);
    const subtreeMtime = newestSubtreeMtimeMs(localPath, agentPaths, (p) => statSync(p).mtimeMs);
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

    const ts = freshBackupTs(BACKUP_BASE);
    const totalCount = redactLiveSubtree(
      localPath,
      mainFindings,
      agentPaths,
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
      log(
        `dry-run: would redact ${totalCount} finding(s) in ${localPath}\n` +
          mainFindings.map((f) => `  line ${f.StartLine} [${f.RuleID}]`).join('\n'),
      );
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
