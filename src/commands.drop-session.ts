import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { REPO_HOME } from './config.ts';
import { acquireLock, die, log, NomadFatal, releaseLock } from './utils.ts';

/**
 * Surgical removal of a contaminated session from the staged tree of
 * `~/claude-nomad/`. Walks `shared/projects/<logical>/<id>.jsonl` at the
 * top level only, classifies each match via `git ls-files --error-unmatch`,
 * and unstages with the appropriate primitive:
 *
 *   - tracked-in-HEAD  -> `git restore --staged --worktree -- <rel>`
 *   - newly-staged     -> `git rm --cached -f -- <rel>`
 *
 * Idempotent: files that are not in the index at all are skipped silently
 * rather than treated as errors. Exits 0 on any drop, including an
 * idempotent re-run that finds the matches already absent. Exits 1 with
 * `[nomad] no staged session matches <id>` only when no
 * `shared/projects/<logical>/<id>.jsonl` exists at all in the shared tree.
 *
 * Defense-in-depth: the id is validated against the same allowlist regex
 * used in `src/resume.ts` before any path composition. argv-array form
 * for every git invocation.
 *
 * NEVER touches `~/.claude/projects/<encoded>/<id>.jsonl`. The local file
 * is preserved so it can race-safely coexist with active Claude Code
 * writers; rotate-and-scrub of the local copy is the user's
 * responsibility.
 *
 * @param id Session id (filename minus `.jsonl`). Must match `[A-Za-z0-9_-]+`
 *           with length 1..128.
 * @throws NomadFatal when a lower-level helper translates a git or
 *         filesystem failure into a fatal. Caught by the try/catch wrapper
 *         which routes it to stderr and sets `process.exitCode = 1`.
 */
export function cmdDropSession(id: string): void {
  if (id.length === 0 || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    console.error(`[nomad] FATAL: invalid session id: ${id}`);
    process.exit(1);
  }
  if (!existsSync(REPO_HOME)) die(`repo not cloned at ${REPO_HOME}`);

  const handle = acquireLock('drop-session');
  if (handle === null) process.exit(0);
  try {
    const repoProjects = join(REPO_HOME, 'shared', 'projects');
    if (!existsSync(repoProjects)) {
      throw new NomadFatal(`no staged session matches ${id}`);
    }
    // Top-level walk only: for each `shared/projects/<logical>/` child,
    // check whether `<id>.jsonl` exists. No descent into
    // subagents/memory/tool-results subdirectories.
    const matches: string[] = [];
    for (const logical of readdirSync(repoProjects)) {
      const candidate = join(repoProjects, logical, `${id}.jsonl`);
      if (existsSync(candidate)) matches.push(candidate);
    }
    if (matches.length === 0) {
      throw new NomadFatal(`no staged session matches ${id}`);
    }
    for (const m of matches) {
      const rel = relative(REPO_HOME, m);
      // Pitfall 7: skip files that are not in the index at all (the
      // load-bearing guard for the idempotent second-run case, where the
      // first drop already removed the entry from the index but left the
      // working tree file in place).
      if (!isInIndex(rel)) {
        log(`dropped ${rel} (already absent from index)`);
        continue;
      }
      if (isTrackedInHead(rel)) {
        execFileSync('git', ['restore', '--staged', '--worktree', '--', rel], {
          cwd: REPO_HOME,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } else {
        execFileSync('git', ['rm', '--cached', '-f', '--', rel], {
          cwd: REPO_HOME,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
      log(`dropped ${rel}`);
    }
  } catch (err) {
    if (err instanceof NomadFatal) {
      // The "no staged session matches <id>" path is a routine
      // not-found result, not an internal failure, so it omits the
      // FATAL: prefix to keep the user-facing wording stable
      // (matches README "Exit codes" copy and the existing test).
      const prefix = err.message.startsWith('no staged session matches ')
        ? '[nomad] '
        : '[nomad] FATAL: ';
      console.error(`${prefix}${err.message}`);
      process.exitCode = 1;
    } else {
      // Defensive escape hatch: only fires if a non-NomadFatal error
      // escapes the try block. No production code path inside the block
      // throws a non-NomadFatal (file-system helpers wrap in NomadFatal,
      // execFileSync failures are recoverable via the helpers' own
      // catches), so this rethrow is unreachable at runtime. Excluded
      // from coverage rather than contorting tests to fake an impossible
      // state.
      /* c8 ignore next */
      throw err;
    }
  } finally {
    releaseLock(handle);
  }
}

/**
 * Is `rel` (repo-relative path) present in the HEAD tree? Wraps
 * `git cat-file -e HEAD:<rel>`: exit 0 means tracked in HEAD,
 * non-zero means either no HEAD exists yet (empty repo) or the path is
 * only in the index (newly-staged-not-in-HEAD). `git ls-files
 * --error-unmatch` is NOT a HEAD-presence check; it matches anything in
 * the index too, which would misclassify newly-staged paths.
 */
function isTrackedInHead(rel: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `HEAD:${rel}`], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Is `rel` present in the index at all? Wraps `git ls-files -- <rel>` and
 * checks for non-empty stdout. Required for the Pitfall 7 idempotency
 * guard: a second invocation on the same id finds the file on disk (per
 * `existsSync`) but absent from the index, and must NOT call `git rm
 * --cached` on it (which would fail with exit 128).
 */
function isInIndex(rel: string): boolean {
  try {
    const out = execFileSync('git', ['ls-files', '--', rel], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.toString().trim() !== '';
  } catch {
    return false;
  }
}
