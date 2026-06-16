import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { claudeHome, repoHome, HOST, type PathMap } from './config.ts';
import { fail } from './utils.ts';
import { readJson, validatePathMapShape } from './utils.json.ts';

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
 * invariant validated in the end-to-end sync phase). All errors go to stderr
 * prefixed with the red `✗` fail glyph; success goes to stdout as a bare
 * shell line (no glyph) so `eval "$(...)"` works.
 */
export function resumeCmd(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || sessionId.length > 128) {
    fail(`invalid session id: ${sessionId}`);
    process.exit(1);
  }

  const projectsRoot = join(claudeHome(), 'projects');
  if (!existsSync(projectsRoot)) {
    fail(`${projectsRoot} does not exist`);
    process.exit(1);
  }

  const jsonlPath = findTranscriptPath(projectsRoot, sessionId);
  if (jsonlPath === null) {
    fail(`session ${sessionId} not found in any ~/.claude/projects/<encoded>/`);
    process.exit(1);
  }
  const recordedCwd = extractRecordedCwd(jsonlPath);
  if (recordedCwd === null) {
    fail(`no cwd field found in ${jsonlPath}`);
    process.exit(1);
  }
  const mapPath = join(repoHome(), 'path-map.json');
  if (!existsSync(mapPath)) {
    fail('path-map.json missing');
    process.exit(1);
  }
  const map = readJson<unknown>(mapPath);
  const schemaError = validatePathMapShape(map);
  if (schemaError !== null) {
    fail(schemaError);
    process.exit(1);
  }
  const hit = lookupLocalPath(map as PathMap, recordedCwd);
  if (hit === null) {
    fail(`cwd ${recordedCwd} from session ${sessionId} not found in path-map.json`);
    process.exit(1);
  }
  if (hit.localPath === undefined) {
    fail(`session ${sessionId} not mapped on this host; add the logical to path-map.json`);
    process.exit(1);
  }

  // Single-quote both interpolations so paths with spaces (or any shell
  // metachar in sessionId) survive `eval` and the cd ends up at the
  // intended directory rather than splitting on whitespace. Success line
  // has NO glyph prefix; meant to be `eval`'d by the user.
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

/**
 * Reverse-lookups the logical project from `recordedCwd`. Matches when
 * `recordedCwd` equals a mapped abspath OR is a descendant of one (a session
 * started inside a subdirectory of a mapped project still resolves). The
 * descendant test uses `startsWith(${root}/)` so `/orig/foo` does not match
 * the project mapped at `/orig/foo-other`. Returns `{ logical, localPath }`
 * (localPath undefined when host missing or 'TBD') or null on no match.
 */
function lookupLocalPath(
  map: PathMap,
  recordedCwd: string,
): { logical: string; localPath: string | undefined } | null {
  for (const [logical, hosts] of Object.entries(map.projects)) {
    const isUnderMappedPath = Object.values(hosts).some(
      (p) => recordedCwd === p || recordedCwd.startsWith(`${p}/`),
    );
    if (isUnderMappedPath) {
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
  const escaped = s.replaceAll("'", String.raw`'\''`);
  return `'${escaped}'`;
}
