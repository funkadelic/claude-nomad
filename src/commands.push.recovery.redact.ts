/**
 * The Redact action for the push-time recovery menu. `applyRedact` resolves a
 * finding's local transcript, refuses live sessions, re-scans the local
 * subtree (main transcript plus every file under `<sid>/`) WITHOUT `--redact`
 * to recover real secret values, rewrites each dirty file in place, and copies
 * the WHOLE session subtree (main `<sid>.jsonl` plus `<sid>/`) back to the
 * staged tree.
 *
 * Split from `commands.push.recovery.actions.ts` to keep both modules under
 * the ~220-line cap. Depends only on lower-level helpers (no import of the
 * actions module), so the dependency direction stays acyclic: actions -> redact.
 */

import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import type { PathMap } from './config.ts';
import { CLAUDE_HOME, HOST, REPO_HOME } from './config.ts';
import { assertSafeLogical } from './config.sharedDirs.guard.ts';
import { resolveLiveTranscript } from './commands.redact.ts';
import {
  applySubtreeRedactions,
  listSubtreeFiles,
  newestSubtreeMtimeMs,
} from './commands.redact.subtree.ts';
import { isRecentlyModified } from './commands.redact.core.ts';
import type { Finding } from './push-gitleaks.scan.ts';
import { scanFile } from './push-gitleaks.scan.ts';
import { encodePath } from './utils.json.ts';
import { log } from './utils.ts';
import { sessionIdFromFinding } from './commands.push.recovery.seams.ts';

/**
 * Resolve the staged `shared/projects/<logical>` destination dir for a local
 * transcript path, or null when no mapped host entry matches. Validates every
 * logical key via `assertSafeLogical` as it walks (a poisoned `..`/separator
 * key fails closed with NomadFatal before any caller mutates local state).
 *
 * @param localPath Absolute path to the live `<sid>.jsonl` transcript.
 * @param map Parsed path-map.
 * @returns The staged project dir, or null when the path maps to no host.
 */
function resolveStagedDir(localPath: string, map: PathMap): string | null {
  for (const [logical, hostMap] of Object.entries(map.projects)) {
    assertSafeLogical(logical);
    const abs = hostMap[HOST];
    if (abs === undefined) continue;
    if (localPath.startsWith(join(CLAUDE_HOME, 'projects', encodePath(abs)) + sep)) {
      return join(REPO_HOME, 'shared', 'projects', logical);
    }
  }
  return null;
}

/**
 * Apply the Redact action for one finding. Resolves the local transcript,
 * checks the live-session guard across the WHOLE subtree (main + every file
 * under `<sid>/`), re-scans each file in the subtree without `--redact` to
 * obtain real secret values, backs up, rewrites each dirty file in place, then
 * copies the WHOLE session subtree (main `<sid>.jsonl` plus `<sid>/`) back to
 * the staged tree. Returns true on success, false when the session is active,
 * unresolvable, or the whole subtree scan finds nothing to redact.
 *
 * Redaction scope equals staging scope: `copyDirJsonlOnly` in `remap.ts`
 * stages every file under `<sid>/` (no extension filter on subdirectories),
 * and `applyRedact` scans and redacts that same set via `listSubtreeFiles`.
 * A secret in `tool-results/*.txt` (or any other subtree file) is therefore
 * caught and scrubbed before the staged copy is written.
 *
 * The trigger finding `f` provides session-id extraction, but its `Match`
 * field comes from a `--redact` scan and is masked. The local re-scan (via
 * `scan`) runs WITHOUT `--redact` so `applyRedactions` receives the real
 * secret values.
 *
 * Path-traversal defense: each logical key is validated via `assertSafeLogical`
 * before any filesystem join, mirroring the guard in `remap.ts`.
 *
 * @param f Trigger finding (used for session-id extraction).
 * @param ts Backup timestamp for `backupBeforeWrite`.
 * @param map Parsed path-map for staged-tree path resolution.
 * @param nowMs Injectable clock for the live-session mtime check.
 * @param scan Injectable scan function for local re-scan (default: `scanFile`).
 * @returns True when the redaction was applied; false when refused or failed.
 */
export function applyRedact(
  f: Finding,
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

  // Derive the session dir (lives alongside the main jsonl) and enumerate the
  // whole subtree so guard and redaction scopes match the push staging scope.
  const sessionDir = join(dirname(localPath), sid);
  const subtreeFiles = listSubtreeFiles(sessionDir);

  // Live-session guard: key on newest mtime across the whole subtree.
  const subtreeMtime = newestSubtreeMtimeMs(localPath, subtreeFiles, (p) => statSync(p).mtimeMs);
  if (isRecentlyModified(subtreeMtime, nowMs())) {
    return refuse(
      `session ${sid} looks active (modified within the last 5 minutes); refusing to redact, no changes made.\n` +
        `  End the session and choose Redact again, or choose Drop session (holds this session back` +
        ` from the push, local copy kept) or Skip.`,
    );
  }

  // Preflight the staged destination BEFORE mutating any local file. Resolving
  // the mapping first means an unmapped session or a poisoned logical key
  // (assertSafeLogical throws) fails closed without having rewritten local
  // transcripts. resolveStagedDir validates every logical key as it walks.
  const stagedProjectDir = resolveStagedDir(localPath, map);
  if (stagedProjectDir === null) {
    return refuse(
      `could not map the local transcript for session ${sid} to a staged copy; choose Drop session or Skip.`,
    );
  }

  // Re-scan main file first; a null return means gitleaks itself failed.
  const mainFindings = scan(localPath);
  if (mainFindings === null) {
    return refuse(`re-scan of the transcript failed; choose Skip or Drop session.`);
  }

  // Redact main + the whole subtree via the shared helper. mainFindings is
  // passed explicitly (already scanned above); subtree files are scanned
  // inside the helper. No rule filter in the recovery path.
  const { total: anyTotal } = applySubtreeRedactions(
    localPath,
    mainFindings,
    subtreeFiles,
    undefined,
    ts,
    scan,
    false,
  );
  if (anyTotal === 0) {
    return refuse(
      `nothing to redact in the local transcript for session ${sid}; choose Skip or Drop session.`,
    );
  }

  // Copy the whole session subtree back to the (already validated) staged tree.
  mkdirSync(stagedProjectDir, { recursive: true });
  cpSync(localPath, join(stagedProjectDir, `${sid}.jsonl`), { force: true });
  // Copy the <sid>/ session dir (contains subagents/, tool-results/, etc.) if present.
  if (existsSync(sessionDir)) {
    cpSync(sessionDir, join(stagedProjectDir, sid), { force: true, recursive: true });
  }

  return true;
}
