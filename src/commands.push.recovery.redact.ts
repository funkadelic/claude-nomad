/**
 * The Redact action for the push-time recovery menu. `applyRedact` resolves a
 * finding's local transcript, refuses live sessions, re-scans the local file
 * WITHOUT `--redact` to recover real secret values, rewrites it in place, and
 * copies the cleaned file back to the staged tree.
 *
 * Split from `commands.push.recovery.actions.ts` to keep both modules under the
 * ~220-line cap. Depends only on lower-level helpers (no import of the actions
 * module), so the dependency direction stays acyclic: actions -> redact.
 */

import { cpSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PathMap } from './config.ts';
import { CLAUDE_HOME, HOST, REPO_HOME } from './config.ts';
import { applyRedactions, isRecentlyModified, resolveLiveTranscript } from './commands.redact.ts';
import type { Finding } from './push-gitleaks.scan.ts';
import { scanFile } from './push-gitleaks.scan.ts';
import { backupBeforeWrite } from './utils.fs.ts';
import { encodePath } from './utils.json.ts';
import { log } from './utils.ts';
import { sessionIdFromFinding } from './commands.push.recovery.seams.ts';

/**
 * Apply the Redact action for one finding. Resolves the local transcript,
 * checks the live-session guard, re-scans the local file (without `--redact`)
 * to obtain real secret values, backs up, rewrites in place (same inode), and
 * surgically copies the file back to the staged tree. Returns true on success,
 * false when the session is active, unresolvable, or the local re-scan fails.
 *
 * The push-verdict findings (`f`, `allFindings`) drive which sessions to act on
 * and provide session-id extraction, but their `Match` fields come from a
 * `--redact` scan and are masked. The local re-scan (via `scan`) runs WITHOUT
 * `--redact` so `applyRedactions` receives the real secret values.
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
  if (isRecentlyModified(statSync(localPath).mtimeMs, nowMs())) {
    return refuse(
      `session ${sid} looks active (modified within the last 5 minutes); refusing to redact, no changes made.\n` +
        `  End the session and choose Redact again, or choose Drop session (holds this session back` +
        ` from the push, local copy kept) or Skip.`,
    );
  }

  // Re-scan without --redact to get real secret values for value-based redaction.
  // Push-verdict findings have masked Match fields and cannot be used directly.
  const realFindings = scan(localPath);
  if (realFindings === null) {
    return refuse(`re-scan of the transcript failed; choose Skip or Drop session.`);
  }
  if (realFindings.length === 0) {
    return refuse(
      `nothing to redact in the local transcript for session ${sid}; choose Skip or Drop session.`,
    );
  }

  backupBeforeWrite(localPath, ts);
  writeFileSync(localPath, applyRedactions(readFileSync(localPath, 'utf8'), realFindings), 'utf8');

  for (const [logical, hostMap] of Object.entries(map.projects)) {
    const abs = hostMap[HOST];
    if (abs === undefined) continue;
    if (localPath.startsWith(join(CLAUDE_HOME, 'projects', encodePath(abs)))) {
      cpSync(localPath, join(REPO_HOME, 'shared', 'projects', logical, `${sid}.jsonl`), {
        force: true,
      });
      break;
    }
  }
  return true;
}
