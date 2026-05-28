import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_HOME, HOST, REPO_HOME, type PathMap } from './config.ts';
import { log } from './utils.ts';
import { encodePath, readJson } from './utils.json.ts';

/**
 * Repo-relative session-match shape `shared/projects/<logical>/...`; the single
 * capture group is the `<logical>` segment fed to the path-map reverse lookup.
 */
const SHARED_PROJECT_LOGICAL = /^shared\/projects\/([^/]+)\//;

/**
 * After a successful drop, remind the operator that the unstage is per-push
 * only: the leaked secret still lives in the local transcript, so the next
 * `nomad push` re-copies it (via `remapPush`) and `nomad doctor --check-shared`
 * keeps reporting it (it scans the live `~/.claude/projects/` source, not the
 * repo index). Points at the exact live transcript when it resolves for this
 * host, or a generic `~/.claude/projects/<encoded>/<id>.jsonl` template
 * otherwise. Advisory output only; never mutates state.
 *
 * @param id Already-validated session id.
 * @param matches Repo-relative paths collected by `collectMatches`.
 */
export function reportScrubHint(id: string, matches: string[]): void {
  const live = resolveLiveTranscript(id, matches);
  const target = live ?? `~/.claude/projects/<encoded>/${id}.jsonl`;
  log(
    'note: this only un-stages the session from the next push. The leaked secret\n' +
      '  is still in your local transcript, so nomad push re-stages it and nomad\n' +
      '  doctor --check-shared keeps reporting it. To remediate, rotate the\n' +
      `  credential, then scrub ${target}`,
  );
}

/**
 * Reverse-map a dropped session to its live transcript
 * `~/.claude/projects/<encoded>/<id>.jsonl` on THIS host via `path-map.json`
 * (`<logical>` -> `hosts[HOST]` -> `encodePath`). Best-effort: returns the path
 * only when it resolves AND exists on disk; null when `path-map.json` is
 * absent or malformed, no match maps to this host, or the live file is already
 * gone. A `'TBD'` host placeholder also yields null (its bogus path never
 * exists). The whole body is wrapped so a malformed map (parse error, `null`
 * projects) degrades to the generic hint instead of crashing the drop.
 *
 * @param id Already-validated session id.
 * @param matches Repo-relative paths collected by `collectMatches`.
 * @returns Absolute live transcript path, or null when unresolvable.
 */
function resolveLiveTranscript(id: string, matches: string[]): string | null {
  try {
    const mapPath = join(REPO_HOME, 'path-map.json');
    if (!existsSync(mapPath)) return null;
    const projects = readJson<PathMap>(mapPath).projects;
    for (const rel of matches) {
      const logical = SHARED_PROJECT_LOGICAL.exec(rel)?.[1];
      /* c8 ignore next -- defensive: every collectMatches path is rooted at shared/projects/<logical>/ */
      if (logical === undefined) continue;
      const abs = projects[logical]?.[HOST];
      // A 'TBD' host placeholder needs no special case: encodePath('TBD') yields
      // a directory that cannot exist among the absolute-path-encoded dirs, so
      // the existsSync guard below rejects it and falls through to the generic.
      if (abs === undefined) continue;
      const live = join(CLAUDE_HOME, 'projects', encodePath(abs), `${id}.jsonl`);
      if (existsSync(live)) return live;
    }
    return null;
  } catch {
    return null;
  }
}
