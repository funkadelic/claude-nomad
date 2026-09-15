/**
 * Pure helper for collecting shared-config file changes to surface in
 * the `nomad push` "Global config" output section. Parses `git diff
 * --name-status -z` output and filters to the shared-config paths that
 * the push allow-list admits (`buildAllowList`), limited under `hosts/` to the
 * current host's override file. Session and extras paths are explicitly
 * excluded so they never appear under "Global config".
 */

import { execFileSync } from 'node:child_process';

import type { PathMap } from '../../core/config.ts';
import { buildAllowList, isAllowed } from './allowlist.ts';

/**
 * One tracked shared-config file change surfaced in the "Global config"
 * push output section.
 *
 * @property status - Raw git status letter (A, M, D, R, C, ...).
 * @property label - Human-readable action label derived from `status`.
 * @property path - Repo-relative path of the changed file.
 */
export type GlobalConfigChange = {
  status: string;
  label: string;
  path: string;
};

/** Maps a git diff status letter to a human-readable label. */
const STATUS_LABELS: Record<string, string> = {
  A: 'add',
  M: 'modify',
  D: 'delete',
  R: 'rename',
  C: 'copy',
  T: 'type-change',
  U: 'unmerged',
  X: 'unknown',
};

/**
 * Derive the label for a given git status token. Rename/copy records carry
 * an optional similarity score suffix (e.g. `R100`); trim that before looking
 * up in the table. Falls back to `'change'` for truly unknown codes.
 *
 * @param statusToken - The raw status token from git (e.g. `'M'`, `'R100'`).
 * @returns A human-readable label.
 */
function labelForStatus(statusToken: string): string {
  /* c8 ignore next */
  const letter = statusToken[0] ?? '';
  return STATUS_LABELS[letter] ?? 'change';
}

/**
 * Return `true` when `filePath` belongs in the "Global config" section: on the
 * push allow-list, not a Sessions or Extras path, and under `hosts/` only the
 * current host's override file.
 *
 * @param filePath - Repo-relative path being tested.
 * @param hostname - Resolved host identifier used to match `hosts/<hostname>.json`.
 * @param allowed - Push allow-list entries from `buildAllowList`.
 * @returns `true` when the path is in scope.
 */
function isInScope(filePath: string, hostname: string, allowed: readonly string[]): boolean {
  if (filePath.startsWith('shared/projects/') || filePath.startsWith('shared/extras/')) {
    return false;
  }
  if (filePath.startsWith('hosts/')) return filePath === `hosts/${hostname}.json`;
  return isAllowed(filePath, allowed);
}

/**
 * Collect shared-config file changes from the git index or working tree.
 *
 * Uses `git diff --cached --name-status -z` when `opts.staged` is `true`
 * (reflecting what `git add -A` staged for the real push), or
 * `git diff HEAD --name-status -z` when `opts.staged` is `false` (for the
 * dry-run path, which stages nothing). Output is NUL-delimited; rename and
 * copy records consume three tokens (status, old path, new path) while all
 * other status codes consume two tokens (status, path).
 *
 * Only paths that pass the shared-config filter are returned. `shared/projects/`
 * (Sessions) and `shared/extras/` (Extras) are always excluded.
 *
 * @param repoHome - Absolute path to the local clone of the sync repo.
 * @param hostname - Resolved host identifier used to match `hosts/<hostname>.json`.
 * @param opts - Options controlling which diff is captured.
 * @param opts.staged - When `true`, diff the index against HEAD; when `false`, diff HEAD vs working tree.
 * @param opts.map - Parsed path-map (for `sharedDirs`), or `null` when there is none.
 * @returns Array of in-scope changes, one entry per affected shared-config file.
 */
export function collectGlobalConfigChanges(
  repoHome: string,
  hostname: string,
  opts: { staged: boolean; map: PathMap | null },
): GlobalConfigChange[] {
  const args = opts.staged
    ? ['diff', '--cached', '--name-status', '-z']
    : ['diff', 'HEAD', '--name-status', '-z'];

  const raw = execFileSync('git', args, {
    cwd: repoHome,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

  const allowed = buildAllowList(opts.map ?? { projects: {} });
  const changes: GlobalConfigChange[] = [];

  // Split on NUL and drop the trailing empty token.
  const tokens = raw.split('\0');
  /* c8 ignore next */
  if (tokens.at(-1) === '') tokens.pop();

  let i = 0;
  while (i < tokens.length) {
    /* c8 ignore start */
    const statusToken = tokens[i++] ?? '';
    if (statusToken === '') continue;

    const firstLetter = statusToken[0] ?? '';
    /* c8 ignore stop */
    const isRenameOrCopy = firstLetter === 'R' || firstLetter === 'C';

    if (isRenameOrCopy) {
      // Consume old path then new path; surface the new path.
      i++; // skip old path
      /* c8 ignore next */
      const newPath = tokens[i++] ?? '';
      if (isInScope(newPath, hostname, allowed)) {
        changes.push({ status: firstLetter, label: labelForStatus(statusToken), path: newPath });
      }
    } else {
      /* c8 ignore next */
      const filePath = tokens[i++] ?? '';
      if (isInScope(filePath, hostname, allowed)) {
        changes.push({ status: firstLetter, label: labelForStatus(statusToken), path: filePath });
      }
    }
  }

  return changes;
}
