import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { REPO_HOME } from './config.ts';
import { acquireLock, die, fail, log, NomadFatal, releaseLock } from './utils.ts';

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
 * `✗ no staged session matches <id>` (red `✗` fail glyph) only when no
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
    fail(`invalid session id: ${id}`);
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
      if (existsSync(candidate)) {
        matches.push(candidate);
      }
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
      try {
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
      } catch (err) {
        // Convert raw execFileSync failures (non-zero git exit, EACCES on
        // .git/index, EPERM, etc.) into NomadFatal so the outer catch can
        // emit a clean `✗ ...` line instead of letting the ExecException
        // bubble past nomad.ts's NomadFatal-only dispatcher.
        // The `?? err.message` fallback only fires when git fails without
        // producing stderr (spawn-level error before the process emits
        // anything), which `cmdPush`'s gitleaks probe already rules out
        // for the typical install path. Excluded from coverage.
        const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
        /* c8 ignore next */
        const detail = e.stderr?.toString().trim() ?? e.message;
        throw new NomadFatal(`git failed to unstage ${rel}: ${detail}`);
      }
      log(`dropped ${rel}`);
    }
  } catch (err) {
    // Defensive escape hatch: only fires if a non-NomadFatal error escapes
    // the try block. All execFileSync mutation failures are wrapped in
    // NomadFatal above, file-system helpers swallow their own errors, and
    // readdirSync only throws under a race we do not handle. Excluded from
    // coverage rather than contorting tests to fake an impossible state.
    /* c8 ignore next 3 */
    if (!(err instanceof NomadFatal)) {
      throw err;
    }
    // All NomadFatal paths surfaced here are exit-1 conditions (no staged
    // session matches the id, git mutation failed, etc.); the red `✗`
    // glyph carries the severity uniformly.
    fail(err.message);
    process.exitCode = 1;
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
 *
 * The catch deliberately collapses three cases to `false`: (a) HEAD has
 * no commit yet (fresh `git init`), (b) HEAD is unresolvable / corrupt
 * (e.g., `.git/refs/heads/main` was deleted manually), and (c) the
 * specific path simply does not exist in a valid HEAD. Git produces the
 * same exit 128 and the same stderr (`fatal: invalid object name 'HEAD'`)
 * for (a) and (b), so a probe-based distinction would require additional
 * git-plumbing reads (`rev-parse --verify HEAD`, `.git/refs/heads/`
 * inspection) that are brittle and break the empty-repo path every
 * existing test runs through. The downstream `git rm --cached -f` is
 * idempotent and produces the user-intended unstage outcome regardless
 * of which case fired, so the collapsed return is intentional. Repo
 * health belongs to `nomad doctor`, not drop-session.
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
