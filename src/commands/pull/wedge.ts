import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The wedge state of a git repository mid-operation.
 *
 * - `'rebase'`: the repo is paused mid-rebase (either the interactive/merge
 *   backend via `.git/rebase-merge`, or the am-backend via `.git/rebase-apply`).
 * - `'merge'`: the repo is paused mid-merge (`.git/MERGE_HEAD` present, no
 *   rebase marker).
 * - `null`: the repo is in a clean state (no in-progress operation).
 *
 * Note: `CHERRY_PICK_HEAD` and `REVERT_HEAD` are intentionally out of scope;
 * nomad never cherry-picks or reverts.
 */
export type WedgeMode = 'rebase' | 'merge' | null;

/**
 * Extended wedge state that includes the unmerged-index-no-active-rebase state.
 *
 * - `'rebase'`: mid-rebase (marker files present).
 * - `'merge'`: mid-merge (`MERGE_HEAD` present, no rebase marker).
 * - `'unmerged-index'`: the index has unmerged stage-2/3 entries but no
 *   active rebase/merge marker. The common post-torn-down-rebase dead end.
 * - `null`: clean state.
 *
 * `WedgeMode` is a strict subset (`'rebase' | 'merge' | null`). The
 * `NonNullable<WedgeMode>` contract in `recoverForceRemote` is unchanged.
 */
export type WedgeState = 'rebase' | 'merge' | 'unmerged-index' | null;

/**
 * Detect whether a git repository is wedged mid-rebase or mid-merge by
 * probing the marker files/dirs in `.git/`. Pure read-only: no git exec, no
 * mutation.
 *
 * Precedence: rebase markers take priority over `MERGE_HEAD` (a repo with
 * both present reports `'rebase'`).
 *
 * @param repo Absolute path to the repository root (where `.git/` lives).
 * @returns `'rebase'` if mid-rebase, `'merge'` if mid-merge, `null` if clean.
 */
export function detectWedge(repo: string): WedgeMode {
  const g = join(repo, '.git');
  if (existsSync(join(g, 'rebase-merge')) || existsSync(join(g, 'rebase-apply'))) return 'rebase';
  if (existsSync(join(g, 'MERGE_HEAD'))) return 'merge';
  return null;
}

/**
 * The outcome of probing the git index for unmerged entries.
 *
 * - `'unmerged'`: the index has stage-2/3 blobs (a conflict is materialized).
 * - `'clean'`: the probe ran and found no unmerged entries.
 * - `'error'`: the probe itself failed (git absent, non-git dir, timeout).
 *   "Clean" and "cannot determine" are DISTINCT so callers can choose their
 *   own bias: wedge detection treats `'error'` as clean (fail-open, deferring
 *   to `gitOrFatal`), the autostash guard treats it as unmerged (fail-closed).
 */
export type IndexProbe = 'unmerged' | 'clean' | 'error';

/**
 * Upper bound on the index probe subprocess. A `git diff` against the local
 * index is normally instant, but this probe is now a hard fail-closed barrier
 * for the autostash guard, so a hung git (e.g. a stuck `.git/index.lock`) must
 * not block the pull/push indefinitely. A timeout throws, is caught, and maps
 * to `'error'` (fail-closed abort), which is the desired outcome. The ceiling
 * is generous so a large-but-healthy repo is never falsely aborted.
 */
const INDEX_PROBE_TIMEOUT_MS = 30_000;

/**
 * Probe the git index for unmerged entries (stage-2/3 blobs). Shell-free
 * argv-array invocation mirroring the `gitCapture`/`gitStatusPorcelainZ`
 * convention in `commands/pull/recovery.ts`.
 *
 * Returns `'unmerged'` when `git diff --diff-filter=U --name-only -z` produces
 * non-empty output (at least one NUL-terminated path), `'clean'` when it runs
 * with no unmerged paths, and `'error'` on any exec failure (git absent,
 * non-git dir, or {@link INDEX_PROBE_TIMEOUT_MS} timeout). The three-state
 * result lets each caller pick its own bias for the undeterminable case; see
 * {@link IndexProbe}.
 *
 * @param repo Absolute path to the repository root.
 * @returns The probe outcome; see {@link IndexProbe}.
 */
export function probeUnmergedIndex(repo: string): IndexProbe {
  let raw: string;
  try {
    raw = execFileSync('git', ['diff', '--diff-filter=U', '--name-only', '-z'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: INDEX_PROBE_TIMEOUT_MS,
    }).toString();
  } catch {
    return 'error'; // non-git dir, git absent, or timeout: caller decides how to bias
  }
  return raw.split('\0').some(Boolean) ? 'unmerged' : 'clean';
}

/**
 * Fail-open boolean view of {@link probeUnmergedIndex} for the wedge-detection
 * callers (`classifyWedge`, push-checks preflight) that intentionally treat
 * "can't tell" as "not wedged" and let the downstream `gitOrFatal` produce the
 * real error. Both `'clean'` and `'error'` map to `false`.
 *
 * @param repo Absolute path to the repository root.
 * @returns `true` only if the index definitively contains unmerged entries.
 */
export function unmergedIndexPresent(repo: string): boolean {
  return probeUnmergedIndex(repo) === 'unmerged';
}

/**
 * Classify the current wedge state AND report the raw {@link IndexProbe}
 * outcome that produced it, in one pass, so a caller that needs both (the
 * `--force-remote` clean-repo info line) never probes the index twice.
 *
 * Precedence (marker states always take priority over the index-only check):
 * 1. If `detectWedge` returns a non-null marker state (`'rebase'` or
 *    `'merge'`), return it verbatim. An active rebase/merge that also has
 *    unmerged index entries is still a marker state. `detectWedge` is a pure
 *    `existsSync` marker probe (no git exec, cannot itself fail), so the
 *    index probe is never run in this branch; `probe` is reported as
 *    `'clean'` here, not because the index was checked and found clean, but
 *    because marker precedence means no caller ever reads `probe` when
 *    `state` is non-null (see `cleanRepoForceRemoteMessage`, the only
 *    reader, which is only called when `state` is `null`).
 * 2. Otherwise probe the index (`probeUnmergedIndex`): `'unmerged'` maps to
 *    `state: 'unmerged-index'`; both `'clean'` and `'error'` (probe could not
 *    run: git absent, non-git dir, or the {@link INDEX_PROBE_TIMEOUT_MS}
 *    timeout) map to `state: null` (fail-open, deferring to `gitOrFatal`),
 *    but `probe` reports which of the two it actually was.
 *
 * `detectWedge` is unchanged (pure file-marker probe, no git exec).
 *
 * @param repo Absolute path to the repository root.
 * @returns The active wedge state (identical to `classifyWedge`'s return)
 *   paired with the `IndexProbe` outcome that produced it.
 */
export function classifyWedgeWithProbe(repo: string): { state: WedgeState; probe: IndexProbe } {
  const mode = detectWedge(repo);
  if (mode !== null) return { state: mode, probe: 'clean' };
  const probe = probeUnmergedIndex(repo);
  return { state: probe === 'unmerged' ? 'unmerged-index' : null, probe };
}

/**
 * Classify the current wedge state, extending `detectWedge` with the
 * unmerged-index-no-active-rebase case. Thin wrapper over
 * {@link classifyWedgeWithProbe} for the three callers
 * (`commands/doctor/checks/git-state.ts`, `commands/push/checks.ts`, and the wedge
 * preflight) that only need the state, not the raw probe outcome.
 *
 * @param repo Absolute path to the repository root.
 * @returns The active wedge state, or `null` if the repo is clean.
 */
export function classifyWedge(repo: string): WedgeState {
  return classifyWedgeWithProbe(repo).state;
}

/**
 * Build the `--force-remote` info line for the non-wedged (`state === null`)
 * case, honoring the {@link IndexProbe} that produced it.
 *
 * `'clean'` is a verified fact: the index probe ran and found nothing, so the
 * approved "repo is clean" wording is accurate. `'error'` means the probe
 * itself could not run (git absent, non-git dir, or a stuck
 * `.git/index.lock` hitting {@link INDEX_PROBE_TIMEOUT_MS}), so the wording
 * must NOT assert the repo is clean when nomad never actually determined
 * that; it states plainly that the wedge state could not be determined.
 * Both variants end identically: the flag's fail-open bias means the pull
 * proceeds normally either way.
 *
 * @param probe The `IndexProbe` outcome from `classifyWedgeWithProbe` (only
 *   meaningful when its `state` is `null`; a marker state never reaches this
 *   helper).
 * @returns The info-line text to log under `--force-remote`.
 */
export function cleanRepoForceRemoteMessage(probe: IndexProbe): string {
  if (probe === 'error') {
    return 'could not determine whether the repo is wedged; continuing with a normal pull';
  }
  return 'repo is clean, nothing to recover; continuing with a normal pull';
}

/**
 * Build the manual-recovery runbook for the unmerged-index-no-active-rebase
 * wedge state. Shared between the pull-side die() and the push-side preflight
 * so the text has one source of truth.
 *
 * The only caller-specific token is the resume command in step 3:
 * `'nomad pull'` on the pull side, `'nomad push'` on the push side.
 *
 * @param resumeCmd The `nomad <subcommand>` to re-run after manual recovery.
 * @returns The actionable runbook string for `die()` / NomadFatal.
 */
export function unmergedIndexRunbookText(resumeCmd: string): string {
  return (
    'repo has an unmerged index with no active rebase or merge in progress ' +
    '(torn-down rebase or merge left stage-2/3 entries behind).\n\n' +
    'Manual recovery:\n' +
    '  1. git reset --mixed HEAD   (clears the stuck index; preserves working-tree files)\n' +
    '  2. git stash list           (look for an orphaned autostash entry)\n' +
    '     git stash pop            (restore the autostash) or\n' +
    '     git stash drop           (discard it)\n' +
    `  3. ${resumeCmd}\n\n` +
    "Auto-recover: run 'nomad pull --force-remote' to apply step 1 automatically\n" +
    '(see FAQ: "Every pull fails with unmerged files")'
  );
}

/**
 * Build the runbook message for the mid-rebase or mid-merge wedge state.
 * Shared between the pull-side `handleWedge` die() and the push-side
 * `wedgePreflight` so the text has one source of truth (mirrors the dedup
 * pattern of `unmergedIndexRunbookText`).
 *
 * @param state `'mid-rebase'` or `'mid-merge'` from the WedgeMode classifier.
 * @returns The actionable runbook string for `die()` / NomadFatal.
 */
export function wedgeMarkerRunbookText(state: 'mid-rebase' | 'mid-merge'): string {
  return (
    `repo is ${state} from a previous failed pull; ` +
    `run 'nomad pull --force-remote' to auto-recover, ` +
    `or resolve manually (see FAQ: "Every pull fails with unmerged files")`
  );
}

/**
 * Scan `git stash list` for an entry matching git's autostash subject format.
 * Returns `true` when such an entry is present.
 *
 * This is a pure presence detector: it NEVER pops, drops,
 * or otherwise mutates the stash. Git writes dropped autostash entries as
 * `stash@{N}: On <branch>: autostash` (or `stash@{N}: autostash` on a
 * detached HEAD). The match anchors on the trailing `: autostash` field to
 * avoid false-positives from user stashes whose message merely mentions the
 * word (e.g. `git stash push -m "wip on autostash detection feature"`).
 * Returns `false` on any exec failure (git absent, non-git dir).
 *
 * @param repo Absolute path to the repository root.
 * @returns `true` if any stash entry has git's autostash subject, else `false`.
 */
export function orphanedAutostashPresent(repo: string): boolean {
  let raw: string;
  try {
    raw = execFileSync('git', ['stash', 'list'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } catch {
    return false; // non-git dir or git absent: not our problem to surface here
  }
  return raw.split('\n').some((line) => /:\s*autostash$/.test(line));
}
