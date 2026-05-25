import { execFileSync } from 'node:child_process';

import { warnGlyph, yellow } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { REPO_HOME } from './config.ts';
import {
  ghAuthStatus,
  isActionsEnabled,
  isRepoPrivate,
  parseGitHubRemote,
  readOriginRemote,
  type SpawnSyncFn,
} from './gh-actions.ts';

/**
 * Drift check appended to the Repository section of `nomad doctor`. WARNs (never
 * FAILs, never sets `process.exitCode`) when the origin remote is a private
 * GitHub mirror that is gh-authed with Actions re-enabled, the quiet failure
 * mode where Actions get turned back on after `nomad init` auto-disabled them
 * (via the GitHub web UI or a stray `gh` call) and the mirror starts firing its
 * workflows on every push again.
 *
 * Reuses the five `gh-actions.ts` primitives unchanged (no new gh wrapper) and
 * clones the `cmdInit` auto-disable gate ORDER, but strips every tip-log and
 * the `disableActions` call: doctor is read-only and SILENT on every miss where
 * init is chatty. The gate chain returns with no output when any of these hold:
 *   gate 1 - the origin remote cannot be read (not a git repo / no origin)
 *   gate 2 - the origin is not a GitHub URL (`parseGitHubRemote` null)
 *   gate 3 - `gh` is not installed or not authed
 *   gate 4 - the repo is public, or the privacy probe throws
 *   gate 5 - Actions are already disabled, or the Actions probe throws
 * Only when all five gates pass does it emit the single yellow WARN line with a
 * `gh api -X PUT ... -F enabled=false` remediation hint (the exact shape
 * `disableActions` would run). The four gh probes (gates 2-5) carry the shared
 * `GH_TIMEOUT_MS` internally; gate 1 is a local `git remote get-url` config read
 * (no network, no timeout needed). No new doctor section; no opt-out flag.
 *
 * @param section - The Repository section to append the WARN line to.
 * @param run - Injectable subprocess runner; defaults to `execFileSync`.
 */
export function reportMirrorActions(section: DoctorSection, run: SpawnSyncFn = execFileSync): void {
  // Gate 1: origin remote. Throws on no remote / non-repo -> silent skip.
  let remote: string;
  try {
    remote = readOriginRemote(REPO_HOME, run);
  } catch {
    return;
  }

  // Gate 2: GitHub remote. Non-GitHub URL parses to null -> silent skip.
  const ref = parseGitHubRemote(remote);
  if (ref === null) return;

  // Gate 3: gh available and authed. Doctor stays silent on both miss reasons
  // (init prints a tip here; doctor does not, per the read-only contract).
  if (ghAuthStatus(run) !== null) return;

  // Gate 4: private mirror. A public repo, or a probe that throws, is a skip.
  let isPrivate: boolean;
  try {
    isPrivate = isRepoPrivate(ref, run);
  } catch {
    return;
  }
  if (!isPrivate) return;

  // Gate 5: Actions enabled. Already-disabled, or a probe that throws, is a skip.
  let enabled: boolean;
  try {
    enabled = isActionsEnabled(ref, run);
  } catch {
    return;
  }
  if (!enabled) return;

  // All gates passed: the private mirror has Actions re-enabled. Emit the
  // single yellow WARN with the exact disable command as the remediation hint.
  addItem(
    section,
    `${yellow(warnGlyph)} mirror Actions: enabled on private mirror ${ref.owner}/${ref.repo} (re-disable with 'gh api -X PUT repos/${ref.owner}/${ref.repo}/actions/permissions -F enabled=false')`,
  );
}
