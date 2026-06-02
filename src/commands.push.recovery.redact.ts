/**
 * The Redact action for the push-time recovery menu. `applyRedact` resolves a
 * finding's local transcript, refuses live sessions, re-scans the local
 * subtree (main transcript plus every `subagents/agent-*.jsonl`) WITHOUT
 * `--redact` to recover real secret values, rewrites each dirty file in place,
 * and copies the WHOLE session subtree (main `<sid>.jsonl` plus `subagents/`)
 * back to the staged tree.
 *
 * Split from `commands.push.recovery.actions.ts` to keep both modules under the
 * ~220-line cap. Depends only on lower-level helpers (no import of the actions
 * module), so the dependency direction stays acyclic: actions -> redact.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import type { PathMap } from './config.ts';
import { CLAUDE_HOME, HOST, REPO_HOME } from './config.ts';
import { assertSafeLogical } from './config.sharedDirs.guard.ts';
import { applyRedactions, isRecentlyModified, resolveLiveTranscript } from './commands.redact.ts';
import { listSubagentTranscripts, newestSubtreeMtimeMs } from './commands.redact.subtree.ts';
import type { Finding } from './push-gitleaks.scan.ts';
import { scanFile } from './push-gitleaks.scan.ts';
import { backupBeforeWrite } from './utils.fs.ts';
import { encodePath } from './utils.json.ts';
import { log } from './utils.ts';
import { sessionIdFromFinding } from './commands.push.recovery.seams.ts';

/**
 * Redact and rewrite every dirty file in the subtree (main + agents). For each
 * path, re-scans with the injected `scan` function; skips files whose scan
 * returns `[]` (clean) or `null` (scan failed individually) without aborting
 * the whole operation. Backs up and rewrites each file that has findings.
 *
 * @param mainPath Absolute path to the main `<sid>.jsonl` transcript.
 * @param agentPaths Absolute paths to every `agent-*.jsonl` in the subtree.
 * @param ts Backup timestamp for `backupBeforeWrite`.
 * @param scan Injectable scan function (without `--redact`).
 * @returns True when at least one file was rewritten; false when every file
 *   either had no findings or the scan failed.
 */
function redactSubtree(
  mainPath: string,
  agentPaths: string[],
  ts: string,
  scan: (p: string) => Finding[] | null,
): boolean {
  const allPaths = [mainPath, ...agentPaths];
  let anyDirty = false;
  for (const filePath of allPaths) {
    const findings = scan(filePath);
    if (findings === null || findings.length === 0) continue;
    backupBeforeWrite(filePath, ts);
    writeFileSync(filePath, applyRedactions(readFileSync(filePath, 'utf8'), findings), 'utf8');
    anyDirty = true;
  }
  return anyDirty;
}

/**
 * Apply the Redact action for one finding. Resolves the local transcript,
 * checks the live-session guard across the whole subtree (main + subagents),
 * re-scans each file in the subtree without `--redact` to obtain real secret
 * values, backs up, rewrites each dirty file in place, then copies the WHOLE
 * session subtree (main `<sid>.jsonl` plus `subagents/`) back to the staged
 * tree. Returns true on success, false when the session is active,
 * unresolvable, or the whole subtree scan finds nothing to redact.
 *
 * The push-verdict findings (`f`, `allFindings`) drive which sessions to act on
 * and provide session-id extraction, but their `Match` fields come from a
 * `--redact` scan and are masked. The local re-scan (via `scan`) runs WITHOUT
 * `--redact` so `applyRedactions` receives the real secret values.
 *
 * Path-traversal defense: each logical key is validated via `assertSafeLogical`
 * before any filesystem join, mirroring the guard in `remap.ts`.
 *
 * @param f Trigger finding (used for session-id extraction).
 * @param allFindings Full finding set for this run (used for session-id
 *   matching; values are masked and not used for redaction).
 * @param ts Backup timestamp for `backupBeforeWrite`.
 * @param map Parsed path-map for staged-tree path resolution.
 * @param nowMs Injectable clock for the live-session mtime check.
 * @param scan Injectable scan function for local re-scan (default: `scanFile`).
 * @returns True when the redaction was applied; false when refused or failed.
 */
export function applyRedact(
  f: Finding,
  allFindings: Finding[],
  ts: string,
  map: PathMap,
  nowMs: () => number,
  scan: (p: string) => Finding[] | null = scanFile,
): boolean {
  /** Emit a refusal message and return false. */
  const refuse = (msg: string): false => {
    log(msg);
    return false;
  };

  const sid = sessionIdFromFinding(f);
  if (sid === null) {
    return refuse(
      `could not locate the local transcript for this finding; choose Skip or Drop session.`,
    );
  }
  const localPath = resolveLiveTranscript(sid);
  if (localPath === null) {
    return refuse(
      `could not locate the local transcript for session ${sid}; choose Skip or Drop session.`,
    );
  }

  // Derive the session dir (lives alongside the main jsonl) and enumerate agents.
  const sessionDir = join(dirname(localPath), sid);
  const agentPaths = listSubagentTranscripts(sessionDir);

  // Live-session guard: key on newest mtime across main + all subagents.
  const subtreeMtime = newestSubtreeMtimeMs(localPath, agentPaths, (p) => statSync(p).mtimeMs);
  if (isRecentlyModified(subtreeMtime, nowMs())) {
    return refuse(
      `session ${sid} looks active (modified within the last 5 minutes); refusing to redact, no changes made.\n` +
        `  End the session and choose Redact again, or choose Drop session (holds this session back` +
        ` from the push, local copy kept) or Skip.`,
    );
  }

  // Re-scan main file first; a null return means gitleaks itself failed.
  const mainFindings = scan(localPath);
  if (mainFindings === null) {
    return refuse(`re-scan of the transcript failed; choose Skip or Drop session.`);
  }

  // Redact main + all agents; skip clean or individually-failed agents silently.
  const anyRewritten = redactSubtree(localPath, agentPaths, ts, (p) => {
    // Main was already scanned above; pass its findings directly to avoid a second scan.
    if (p === localPath) return mainFindings;
    return scan(p);
  });
  if (!anyRewritten) {
    return refuse(
      `nothing to redact in the local transcript for session ${sid}; choose Skip or Drop session.`,
    );
  }

  // Copy the whole session subtree back to the staged tree.
  let copied = false;
  for (const [logical, hostMap] of Object.entries(map.projects)) {
    assertSafeLogical(logical);
    const abs = hostMap[HOST];
    if (abs === undefined) continue;
    if (localPath.startsWith(join(CLAUDE_HOME, 'projects', encodePath(abs)) + sep)) {
      const stagedProjectDir = join(REPO_HOME, 'shared', 'projects', logical);
      // Copy main <sid>.jsonl.
      mkdirSync(stagedProjectDir, { recursive: true });
      cpSync(localPath, join(stagedProjectDir, `${sid}.jsonl`), { force: true });
      // Copy the <sid>/ session dir (contains subagents/) if it exists.
      if (existsSync(sessionDir)) {
        cpSync(sessionDir, join(stagedProjectDir, sid), { force: true, recursive: true });
      }
      copied = true;
      break;
    }
  }
  if (!copied) {
    return refuse(
      `could not map the local transcript for session ${sid} to a staged copy; choose Drop session or Skip.`,
    );
  }
  return true;
}
