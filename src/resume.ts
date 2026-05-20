import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_HOME, HOST, REPO_HOME, type PathMap } from './config.ts';
import { readJson } from './utils.ts';

type TranscriptLine = { type?: string; cwd?: string };

/**
 * Read-only sidecar that resolves a session ID to a host-local
 * `cd <abspath> && claude --resume <id>` line, printed to stdout for `eval`.
 *
 * Flow: locate `<id>.jsonl` under `~/.claude/projects/<encoded>/`, extract
 * the first non-file-history-snapshot line's `cwd`, reverse-lookup the
 * logical project name in `path-map.json`, then look up the current host's
 * abspath for that logical project.
 *
 * Does NOT acquire the nomad lock (read-only paths stay race-tolerant) and
 * does NOT mutate any `.jsonl` byte (preserves the transcript byte-equality
 * invariant validated in the end-to-end sync phase). All errors go to
 * stderr with the `[nomad] FATAL:` prefix; success goes to stdout WITHOUT
 * the prefix so `eval "$(...)"` works.
 */
export function resumeCmd(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || sessionId.length > 128) {
    console.error(`[nomad] FATAL: invalid session id: ${sessionId}`);
    process.exit(1);
  }

  const projectsRoot = join(CLAUDE_HOME, 'projects');
  if (!existsSync(projectsRoot)) {
    console.error(`[nomad] FATAL: ${projectsRoot} does not exist`);
    process.exit(1);
  }

  const jsonlPath = findTranscriptPath(projectsRoot, sessionId);
  if (jsonlPath === null) {
    console.error(
      `[nomad] FATAL: session ${sessionId} not found in any ~/.claude/projects/<encoded>/`,
    );
    process.exit(1);
  }
  const recordedCwd = extractRecordedCwd(jsonlPath);
  if (recordedCwd === null) {
    console.error(`[nomad] FATAL: no cwd field found in ${jsonlPath}`);
    process.exit(1);
  }
  const mapPath = join(REPO_HOME, 'path-map.json');
  if (!existsSync(mapPath)) {
    console.error('[nomad] FATAL: path-map.json missing');
    process.exit(1);
  }
  const map = readJson<PathMap>(mapPath);
  const hit = lookupLocalPath(map, recordedCwd);
  if (hit === null) {
    console.error(
      `[nomad] FATAL: cwd ${recordedCwd} from session ${sessionId} not found in path-map.json`,
    );
    process.exit(1);
  }
  if (hit.localPath === undefined) {
    console.error(
      `[nomad] FATAL: session ${sessionId} not mapped on this host; add the logical to path-map.json`,
    );
    process.exit(1);
  }

  // Single-quote both interpolations so paths with spaces (or any shell
  // metachar in sessionId) survive `eval` and the cd ends up at the
  // intended directory rather than splitting on whitespace. Success line
  // has NO [nomad] prefix; meant to be `eval`'d by the user.
  console.log(`cd ${shQuote(hit.localPath)} && claude --resume ${shQuote(sessionId)}`);
}

/** Walks `<projectsRoot>/<dir>/<sessionId>.jsonl` and returns the first existing path, or null. */
function findTranscriptPath(projectsRoot: string, sessionId: string): string | null {
  for (const dir of readdirSync(projectsRoot)) {
    const candidate = join(projectsRoot, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Returns the first non-file-history-snapshot line's `cwd` from the transcript, or null. */
function extractRecordedCwd(jsonlPath: string): string | null {
  for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as TranscriptLine;
      if (obj.type === 'file-history-snapshot') continue;
      if (typeof obj.cwd === 'string' && obj.cwd.length > 0) return obj.cwd;
    } catch {
      // Skip non-JSON or partial lines; transcripts can be appended mid-write.
    }
  }
  return null;
}

/** Reverse-lookups the logical project from `recordedCwd`; returns null when no logical contains it, else `{ logical, localPath }` (localPath undefined when host missing or 'TBD'). */
function lookupLocalPath(
  map: PathMap,
  recordedCwd: string,
): { logical: string; localPath: string | undefined } | null {
  for (const [logical, hosts] of Object.entries(map.projects)) {
    if (Object.values(hosts).includes(recordedCwd)) {
      const localPath = hosts[HOST];
      return { logical, localPath: localPath === 'TBD' ? undefined : localPath };
    }
  }
  return null;
}

/**
 * POSIX single-quote escape: wraps `s` in `'...'` and rewrites each interior
 * `'` as `'\''`. Safe for `eval` and `bash -c`. Used to keep shell
 * metacharacters in the resume output from being interpreted by the user's
 * shell when they pipe the output through `eval`.
 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
