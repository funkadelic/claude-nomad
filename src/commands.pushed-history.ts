import { execFileSync } from 'node:child_process';

import { log } from './utils.ts';

/**
 * Resolve the remote-tracking ref that represents pushed history (the upstream
 * of the current branch, e.g. `origin/main`). Returns null when there is no
 * upstream (a local-only repo that has never pushed), a detached HEAD, or the
 * directory is not a git repo. Best-effort and read-only: any git failure
 * degrades to null so callers stay silent rather than crash.
 *
 * @param repo Resolved repo root path for this invocation.
 * @returns The upstream ref name, or null when none resolves.
 */
function pushedRef(repo: string): string | null {
  try {
    const ref = execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return ref.length > 0 ? ref : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort check: is session `id` present anywhere in the pushed
 * (remote-tracking) history of the sync repo? True when at least one commit
 * reachable from the upstream ref touched `shared/projects/<logical>/<id>.jsonl`
 * or the sibling `<id>/` subtree. The remote ref is only as fresh as the last
 * fetch/push, which is exactly the point: a session published by a prior
 * `nomad push` (which advances the local `origin/...` ref) is reported, while a
 * still-unpushed local commit is not.
 *
 * Returns false on any git error or when there is no upstream, so callers
 * degrade silently. The id is already validated against `[A-Za-z0-9_-]+` by
 * both callers, so it carries no pathspec glob metacharacters.
 *
 * @param id Already-validated session id.
 * @param repo Resolved repo root path for this invocation.
 * @returns True when the session appears in pushed history.
 */
export function sessionInPushedHistory(id: string, repo: string): boolean {
  const ref = pushedRef(repo);
  if (ref === null) return false;
  try {
    const out = execFileSync(
      'git',
      [
        'log',
        ref,
        '--oneline',
        '-1',
        '--',
        `shared/projects/*/${id}.jsonl`,
        `shared/projects/*/${id}/*`,
      ],
      { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .toString()
      .trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

/**
 * Emit the already-pushed-history remediation warning when session `id` is
 * already in pushed history. `nomad drop-session` and `nomad redact` only touch
 * the local worktree/index, so neither removes a secret that left in a prior
 * push: full remediation needs history rewrite + force-push + credential
 * rotation. Advisory only; never mutates state and no-ops when the session is
 * not in pushed history (or detection is unavailable).
 *
 * @param id Already-validated session id.
 * @param repo Resolved repo root path for this invocation.
 */
export function warnIfSessionPushed(id: string, repo: string): void {
  if (!sessionInPushedHistory(id, repo)) return;
  log(
    `warning: session ${id} is already in pushed history (origin).\n` +
      '  This command only changes your local copy and the next push; it does NOT\n' +
      '  remove the secret from commits already on the remote.\n' +
      '  To fully remediate a real secret: rotate the credential, then rewrite\n' +
      '  history (e.g. with git filter-repo) and force-push, coordinating with\n' +
      '  anyone else who has cloned the repo.',
  );
}
