/**
 * Push-side manifest surface: the gitleaks config identity that invalidates
 * the manifest, plus a re-export of the shared store in `sync/manifest.ts` so
 * push modules and their module mocks keep one import path. Mocking this
 * module does not reach sync-side callers such as the shared-links baseline.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoHome } from '../../core/config.ts';
import { resolveTomlPath } from './gitleaks.config.ts';

export * from '../../sync/manifest.ts';

/**
 * Compute a stable identity string for a file, or a stable "absent" marker
 * when the file does not exist. Used by `computeConfigHash` to feed the hash
 * over all three gitleaks config inputs; an absent file always contributes the
 * same marker so the config hash is stable across calls when no files change.
 */
function fileIdentity(p: string | null): string {
  /* c8 ignore start */
  if (p === null) return 'none::absent';
  /* c8 ignore stop */
  if (!existsSync(p)) return `${p}::absent`;
  return `${p}::${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
}

/**
 * Compute the config identity hash over the three gitleaks config inputs:
 * the active base `.gitleaks.toml` (repo-local or bundled, per `resolveTomlPath`),
 * `REPO_HOME/.gitleaks.overlay.toml`, and `REPO_HOME/.gitleaksignore`. A change
 * to any of these triggers a full rescan on the next push. Absent files contribute
 * a stable "absent" marker so the hash is stable when no files change.
 *
 * @returns Lowercase hex SHA-256 of the concatenated file identities.
 */
export function computeConfigHash(): string {
  const repo = repoHome();
  const parts = [
    fileIdentity(resolveTomlPath(repo)),
    fileIdentity(join(repo, '.gitleaks.overlay.toml')),
    fileIdentity(join(repo, '.gitleaksignore')),
  ];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}
