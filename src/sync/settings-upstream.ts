/**
 * Settings merge at the pre-pull HEAD, so the settings refusal can tell an
 * upstream removal from a local addition. Every failure yields `{}`, which
 * excludes nothing from the refusal.
 */

import { HOST } from '../core/config.ts';
import { gitProbe } from '../core/git-probe.ts';
import { deepMerge } from '../core/utils.json.ts';

/**
 * Parse `<sha>:<rel>` from `repo` as a JSON object.
 * @param repo - Absolute path to the sync repo.
 * @param sha - Commit to read from.
 * @param rel - Repo-relative path, forward slashes.
 * @returns The object, or `null` on a failed read, a parse error, or a non-object.
 */
function jsonObjectAt(repo: string, sha: string, rel: string): Record<string, unknown> | null {
  const text = gitProbe(['show', `${sha}:${rel}`], repo);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Base + host merge as committed at `heads.pre`; an absent host file merges as `{}`.
 * @param repo - Absolute path to the sync repo.
 * @param heads - Pre/post-pull HEADs; `undefined` when they could not be captured.
 * @returns The pre-pull merge, or `{}` when HEAD did not move or any read fails.
 */
export function preRebaseSettingsMerge(
  repo: string,
  heads: { pre: string; post: string } | undefined,
): Record<string, unknown> {
  if (heads === undefined || heads.pre === heads.post) return {};
  const hostRel = `hosts/${HOST}.json`;
  const listed = gitProbe(['ls-tree', '--name-only', heads.pre, '--', hostRel], repo);
  if (listed === null) return {};
  const base = jsonObjectAt(repo, heads.pre, 'shared/settings.base.json');
  const host = listed.trim() === '' ? {} : jsonObjectAt(repo, heads.pre, hostRel);
  if (base === null || host === null) return {};
  return deepMerge(base, host);
}
