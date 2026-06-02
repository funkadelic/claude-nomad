/**
 * Pure helpers for enumerating and inspecting a session's live `subagents/`
 * subtree. These functions contain no I/O side effects beyond reading the
 * filesystem (readdirSync, existsSync, statSync) and accept injectable
 * dependencies for testability.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Return the absolute paths of every `agent-*.jsonl` file under
 * `<sessionDir>/subagents/`. Returns an empty array when the session directory
 * does not exist, when the `subagents/` subdirectory does not exist, or when no
 * matching entries are found. `.meta.json` siblings and any non-`agent-*.jsonl`
 * entries are excluded.
 *
 * Mirrors the `existsSync + statSync(...).isDirectory()` guard shape used by
 * `collectMatches` in `commands.drop-session.ts`.
 *
 * @param sessionDir Absolute path to `<encoded>/<sid>` (the session directory,
 *   NOT the `.jsonl` file).
 * @returns Sorted absolute paths of all `agent-*.jsonl` files found.
 */
export function listSubagentTranscripts(sessionDir: string): string[] {
  const subagentsDir = join(sessionDir, 'subagents');
  if (!existsSync(subagentsDir)) return [];
  if (!statSync(subagentsDir).isDirectory()) return [];

  const entries = readdirSync(subagentsDir);
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('agent-') && entry.endsWith('.jsonl')) {
      result.push(join(subagentsDir, entry));
    }
  }
  return result;
}

/**
 * Return the maximum `mtimeMs` across a session's main transcript and every
 * agent transcript path. Uses the injected `statMtime` reader so callers can
 * bypass the live filesystem in tests.
 *
 * Guard policy: the live-session guard must key on the NEWEST mtime across the
 * whole subtree (main + all subagents), because an actively-written subagent
 * file should prevent redaction of the entire session even when the main file
 * itself is quiescent.
 *
 * @param mainPath Absolute path to the main `<sid>.jsonl` transcript.
 * @param agentPaths Absolute paths to each `agent-*.jsonl` file.
 * @param statMtime Injectable mtime reader; defaults to real `statSync`.
 * @returns The highest mtime in milliseconds found across the whole subtree.
 */
export function newestSubtreeMtimeMs(
  mainPath: string,
  agentPaths: string[],
  statMtime: (p: string) => number = (p) => statSync(p).mtimeMs,
): number {
  let newest = statMtime(mainPath);
  for (const agentPath of agentPaths) {
    const t = statMtime(agentPath);
    if (t > newest) newest = t;
  }
  return newest;
}
