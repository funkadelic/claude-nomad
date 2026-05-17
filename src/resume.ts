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
  // Reject anything that could escape the transcript scope when interpolated
  // into a filesystem path below. Claude Code session ids are UUIDs (hex +
  // dashes); 128 chars is generous headroom without becoming a DoS vector.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || sessionId.length > 128) {
    console.error(`[nomad] FATAL: invalid session id: ${sessionId}`);
    process.exit(1);
  }

  const projectsRoot = join(CLAUDE_HOME, 'projects');
  if (!existsSync(projectsRoot)) {
    console.error(`[nomad] FATAL: ${projectsRoot} does not exist`);
    process.exit(1);
  }

  let jsonlPath: string | null = null;
  for (const dir of readdirSync(projectsRoot)) {
    const candidate = join(projectsRoot, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      jsonlPath = candidate;
      break;
    }
  }
  if (jsonlPath === null) {
    console.error(
      `[nomad] FATAL: session ${sessionId} not found in any ~/.claude/projects/<encoded>/`,
    );
    process.exit(1);
  }

  // Read the FIRST non-file-history-snapshot line that has a `cwd` field.
  // Line 1 of a transcript is always `{"type":"file-history-snapshot",...}` and
  // carries no cwd; the cwd lives on the next semantic event (attachment/user).
  const content = readFileSync(jsonlPath, 'utf8');
  let recordedCwd: string | null = null;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj: TranscriptLine;
    try {
      obj = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (obj.type === 'file-history-snapshot') continue;
    if (typeof obj.cwd === 'string' && obj.cwd.length > 0) {
      recordedCwd = obj.cwd;
      break;
    }
  }
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

  let logical: string | null = null;
  for (const [name, hosts] of Object.entries(map.projects)) {
    if (Object.values(hosts).includes(recordedCwd)) {
      logical = name;
      break;
    }
  }
  if (logical === null) {
    console.error(
      `[nomad] FATAL: cwd ${recordedCwd} from session ${sessionId} not found in path-map.json`,
    );
    process.exit(1);
  }

  const localPath = map.projects[logical][HOST];
  if (localPath === undefined || localPath === 'TBD') {
    console.error(
      `[nomad] FATAL: session ${sessionId} not mapped on this host; add the logical to path-map.json`,
    );
    process.exit(1);
  }

  // Single-quote both interpolations so paths with spaces (or any shell
  // metachar in sessionId) survive `eval` and the cd ends up at the
  // intended directory rather than splitting on whitespace. Success line
  // has NO [nomad] prefix; meant to be `eval`'d by the user.
  console.log(`cd ${shQuote(localPath)} && claude --resume ${shQuote(sessionId)}`);
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
