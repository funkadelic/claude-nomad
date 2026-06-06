import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { repoHome } from './config.ts';
import { expandStagedDir, isInIndex, isTrackedInHead } from './commands.drop-session.git.ts';
import { reportScrubHint } from './commands.drop-session.scrub-hint.ts';
import { die, fail, item, NomadFatal } from './utils.ts';
import { acquireLock, releaseLock } from './utils.lockfile.ts';

/**
 * Surgical removal of a contaminated session from the staged tree of
 * `~/claude-nomad/`. Thin orchestrator: validates the id, acquires the
 * lock, collects every staged path matching the flat `<id>.jsonl` and the
 * sibling subagent directory `<id>/` (via `collectMatches`), then unstages
 * each (via `unstageOne`). This closes the leak where a "dropped" session
 * still shipped its subagent transcripts. A successful drop ends with
 * `reportScrubHint`, which reminds the operator that the unstage is per-push
 * only and points at the live transcript that still needs scrubbing.
 *
 * Idempotent: entries not in the index are skipped silently. Exits 0 on
 * any drop (including an idempotent re-run); exits 1 with `✗ no staged
 * session matches <id>` only when neither a flat `<id>.jsonl` nor a
 * `<id>/` directory with staged entries exists anywhere in the tree.
 *
 * Defense-in-depth: the id is validated against the same allowlist regex
 * used in `src/resume.ts` before any path composition or lock acquisition.
 * argv-array form for every git invocation.
 *
 * NEVER touches `~/.claude/projects/<encoded>/<id>.jsonl` or the local
 * `<id>/` tree; the local copies are preserved so they race-safely
 * coexist with active Claude Code writers.
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
  // Resolve root once per command invocation (T-45-02 TOCTOU mitigation).
  const repo = repoHome();
  if (!existsSync(repo)) die(`repo not cloned at ${repo}`);

  const handle = acquireLock('drop-session');
  if (handle === null) process.exit(0);
  try {
    const repoProjects = join(repo, 'shared', 'projects');
    if (!existsSync(repoProjects)) {
      throw new NomadFatal(`no staged session matches ${id}`);
    }
    const matches = collectMatches(repoProjects, id, repo);
    if (matches.length === 0) {
      throw new NomadFatal(`no staged session matches ${id}`);
    }
    for (const rel of matches) unstageOne(rel, repo);
    reportScrubHint(id, matches);
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
 * Collect repo-relative staged paths matching the session `id`. For each
 * `shared/projects/<logical>/` child, match the flat `<id>.jsonl` plus the
 * sibling subagent directory `<id>/`. The directory is expanded into its
 * staged entries via `expandStagedDir` so every nested file flows through
 * the same per-entry unstage loop as the flat jsonl.
 *
 * @param repoProjects Absolute path to `<REPO_HOME>/shared/projects`.
 * @param id Already-validated session id (see `cmdDropSession`'s entry guard).
 * @returns Repo-relative paths to unstage (possibly empty).
 */
function collectMatches(repoProjects: string, id: string, repo: string): string[] {
  const matches: string[] = [];
  for (const logical of readdirSync(repoProjects)) {
    const candidate = join(repoProjects, logical, `${id}.jsonl`);
    if (existsSync(candidate)) {
      matches.push(relative(repo, candidate));
    }
    const dir = join(repoProjects, logical, id);
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      const dirRel = relative(repo, dir);
      const staged = expandStagedDir(dirRel);
      // A dir present on disk but absent from the index is an already-dropped
      // rerun: push the dir path itself so the per-entry isInIndex() guard
      // logs it as "already absent" rather than letting an empty match set
      // escalate to the no-match fatal (idempotency for dir-only sessions).
      if (staged.length > 0) matches.push(...staged);
      else matches.push(dirRel);
    }
  }
  return matches;
}

/**
 * Unstage one repo-relative path via the tracked-vs-newly-staged primitive.
 * Skips paths absent from the index (Pitfall 7 idempotency guard), then
 * classifies via `isTrackedInHead` and unstages with `git restore
 * --staged --worktree` (tracked-in-HEAD) or `git rm --cached -f`
 * (newly-staged). Git calls keep `execFileSync` argv-array form (PUSH-04).
 *
 * @param rel Repo-relative path to unstage.
 * @throws NomadFatal when the underlying git invocation fails.
 */
function unstageOne(rel: string, repo: string): void {
  // Pitfall 7: skip files that are not in the index at all (the
  // load-bearing guard for the idempotent second-run case, where the
  // first drop already removed the entry from the index but left the
  // working tree file in place).
  if (!isInIndex(rel)) {
    item(`dropped ${rel} (already absent from index)`);
    return;
  }
  try {
    if (isTrackedInHead(rel)) {
      execFileSync('git', ['restore', '--staged', '--worktree', '--', rel], {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      execFileSync('git', ['rm', '--cached', '-f', '--', rel], {
        cwd: repo,
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
  item(`dropped ${rel}`);
}
