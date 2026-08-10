import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { backupBase, HOST, manifestPath, repoHome } from './config.ts';
import { computeConfigHash, readManifest } from './push-manifest.ts';
import { loadSelectionForPush } from './commands.push.selection.ts';
import { enforceAllowList } from './commands.push.allowlist.ts';
import { buildNoScanSections, type PushState, renderNoScanTree } from './commands.push.sections.ts';
import { reportSettingsAheadDrift, stripGsdHooksFromBase } from './commands.push.settings.ts';
import { guardGitlinks, guardResolutionModeConflicts } from './commands.push.guards.ts';
import { commitAndPush, runDryRunPreview } from './commands.push.steps.ts';
import type { DoctorSection } from './output-tree.ts';
import { remapExtrasPush } from './extras-sync.ts';
import { syncSharedLinksPush } from './links.mirror.ts';
import { syncSkillsPush } from './skills-sync.ts';
import { probeGitleaks, rebaseBeforePush } from './push-checks.ts';
import { remapPush } from './remap.ts';
import { withSpinner } from './spinner.ts';
import { die, fail, gitCaptureRaw, gitStatusPorcelainZ, log, NomadFatal } from './utils.ts';
import { freshBackupTs } from './utils.fs.ts';
import { acquireLock, releaseLock } from './utils.lockfile.ts';

export { reportSettingsAheadDrift } from './commands.push.settings.ts';

/**
 * Discriminated result returned by `runPushCore`, describing what happened
 * without the caller needing to re-derive it: `nothing` for the real-push
 * "nothing to commit" early return, `dry` for either dry-run preview path
 * (with or without a `path-map.json`), and `pushed` for a completed
 * `commitAndPush`. A composing caller (e.g. `nomad sync`) can use the tag
 * alone to decide whether anything changed. Without `opts.compose`, the push
 * tree still renders inside `commitAndPush`/`runDryRunPreview`/
 * `renderNoScanTree` exactly as before this extraction (see those functions'
 * JSDoc for the render detail) and `sections` is absent. Under
 * `opts.compose`, the `nothing` and `pushed` arms carry the built (unrendered)
 * push tree sections so the composing caller owns the single merged render;
 * `sections` is empty on the resolved-leak path (already rendered inline, see
 * `commitAndPush`).
 *
 * `aheadOfOrigin` is set on every compose-mode `nothing` arm (the
 * empty-status early return and the gsd-only staged-drop no-op): `true`
 * when the sync repo's HEAD carries commits its upstream lacks (e.g. a prior
 * push committed but the network push failed), so a composing caller must not
 * report the run as fully in sync even though there was nothing to commit.
 *
 * `globalConfigCount` (changed shared-config file count) and `collisions`
 * (push remap collision count, always `0` on the success path since a real
 * collision throws instead of returning) are set alongside `sections` on
 * every compose-mode `nothing`/`pushed` arm so a composing caller
 * (`nomad sync`) can build its own summary row without re-deriving the counts
 * from `st`.
 */
export type PushCoreResult =
  | {
      tag: 'nothing';
      sections?: DoctorSection[];
      aheadOfOrigin?: boolean;
      globalConfigCount?: number;
      collisions?: number;
    }
  | { tag: 'dry' }
  | { tag: 'pushed'; sections?: DoctorSection[]; globalConfigCount?: number; collisions?: number };

/**
 * Best-effort probe for committed-but-unpushed state: count the commits the
 * sync repo's HEAD has that its upstream lacks. Any git failure (no upstream
 * configured, detached HEAD) yields `false` so callers preserve the
 * pre-probe behavior. Never prints anything: output is captured, and a
 * failure is swallowed.
 *
 * @param repo - Resolved repo root path for this invocation.
 * @returns `true` when at least one local commit is missing from upstream.
 */
function aheadOfUpstream(repo: string): boolean {
  try {
    const raw = gitCaptureRaw(['rev-list', '--count', '@{u}..HEAD'], repo);
    return Number.parseInt(raw.trim(), 10) > 0;
  } catch {
    return false;
  }
}

/**
 * Handle the real-push empty-status early return. Standalone push logs
 * `nothing to commit` and renders the no-scan tree inline; a composing caller
 * (`compose`) gets the built sections back unrendered instead, plus the
 * `aheadOfOrigin` probe result so a clean worktree sitting on unpushed
 * commits is never reported as fully in sync, plus `globalConfigCount`/
 * `collisions` read off `st` (an empty status means nothing changed, so both
 * are `0` here in practice). The probe runs only under `compose`: standalone
 * push output and side effects stay byte-identical. Extracted from
 * `runPushCore` to keep it under the sonarjs cognitive-complexity threshold.
 *
 * @param st - The collected push state.
 * @param compose - Composing-caller render mode (see `runPushCore`).
 * @param repo - Resolved repo root path for the ahead-of-upstream probe.
 * @returns The `nothing`-tagged result, with `sections`/`aheadOfOrigin`/
 *   `globalConfigCount`/`collisions` only under `compose`.
 */
function emptyStatusResult(st: PushState, compose: boolean, repo: string): PushCoreResult {
  if (compose) {
    return {
      tag: 'nothing',
      sections: buildNoScanSections(st),
      aheadOfOrigin: aheadOfUpstream(repo),
      globalConfigCount: st.globalConfig.length,
      collisions: st.remap.collisions,
    };
  }
  log('nothing to commit');
  renderNoScanTree(st);
  return { tag: 'nothing' };
}

/**
 * Map `commitAndPush`'s object return onto a `PushCoreResult`: under
 * `compose` the arm carries the built sections so the composing caller owns
 * the render; otherwise the tag alone (standalone push already rendered).
 * The compose-mode `nothing` arm (the gsd-only staged-drop no-op) runs the
 * same ahead-of-upstream probe as the empty-status arm, so no `nothing`
 * result a composing caller sees can hide unpushed commits. Both compose-mode
 * arms also carry `globalConfigCount`/`collisions` read off `st`, which
 * `commitAndPush` has already mutated in place (`st.globalConfig`) by the
 * time this runs.
 *
 * @param outcome - `commitAndPush`'s outcome.
 * @param sections - The built push tree sections `commitAndPush` returned.
 * @param compose - Composing-caller render mode (see `runPushCore`).
 * @param repo - Resolved repo root path for the ahead-of-upstream probe.
 * @param st - The collected push state (already mutated by `commitAndPush`).
 * @returns The `nothing`- or `pushed`-tagged result.
 */
function toPushCoreResult(
  outcome: 'pushed' | 'nothing',
  sections: DoctorSection[],
  compose: boolean,
  repo: string,
  st: PushState,
): PushCoreResult {
  if (!compose) return { tag: outcome };
  const globalConfigCount = st.globalConfig.length;
  const collisions = st.remap.collisions;
  if (outcome === 'nothing') {
    return {
      tag: 'nothing',
      sections,
      aheadOfOrigin: aheadOfUpstream(repo),
      globalConfigCount,
      collisions,
    };
  }
  return { tag: 'pushed', sections, globalConfigCount, collisions };
}

/**
 * Lock-free core of `nomad push`: runs the pre-push safety checks in the
 * order from CONTEXT.md, stages, and pushes:
 *   1. `probeGitleaks` (fail fast if the secret scanner isn't on PATH)
 *   2. `rebaseBeforePush` (surface remote conflicts against committed state,
 *      not against in-flight `remapPush` copies)
 *   3. `remapPush` (copy host-encoded session dirs into shared logical names)
 *   4. `remapExtrasPush` (copy whitelisted per-project extras under
 *      `shared/extras/<logical>/<dirname>/`, between `remapPush` and the
 *      gitlink walk so produced paths reach both the walk and the allow-list)
 *   5. `findGitlinks` walk of `shared/` (refuse to push nested .git entries)
 *   6. allow-list enforcement on the resulting `git status` (runtime
 *      `shared/extras/<logical>/` prefix per declared logical added)
 *   7. `git add -A` -> `scanPushVerdict` on staged tree -> `git commit` -> `git push`
 *
 * Assumes the caller already holds the process-wide lock: this function never
 * acquires or releases the lock itself, so it can run standalone (wrapped by
 * `cmdPush`) or as one half of a composing command (e.g. a future
 * `nomad sync`) that holds the lock across both the pull and push halves. It
 * also never catches a fatal error internally; any thrown fault propagates to
 * the caller, whose `try`/`finally` is responsible for releasing the lock.
 *
 * Output is a doctor-style grouped tree: a `push on host=...` header, then
 * `Sessions` / `Extras` / `Leak scan` / `Summary` sections rendered with
 * connector glyphs. Pushed sessions and extras list one row each; the
 * per-project "not in path-map" skips collapse to one count row. The Leak
 * scan section shows a clean-scan row, or on a leak a one-line verdict row
 * plus the full recovery block printed BELOW the rendered tree.
 *
 * The WET-path Summary row (including the warn case) renders to STDOUT as
 * part of the grouped tree via `renderTree`, not to stderr via `warn` as in
 * the pre-tree behavior. The dry-run preview likewise renders via
 * `renderTree` (push has no dry-run stderr-summary path; `cmdPull`'s dry-run
 * does, see its JSDoc for the intentional wet-stdout/dry-pull-stderr stream
 * split).
 *
 * The gitleaks scan runs AFTER staging so it sees what would actually be
 * pushed, but BEFORE commit so a detection unwinds cleanly without leaving a
 * commit to amend or revert. A real-push leak re-raises the recovery body as
 * a fatal error AFTER the tree renders so the recovery block follows the
 * tree; that fault propagates to the caller unhandled (see above).
 *
 * `opts.dryRun` (default `false`): when `true`, the network round-trip
 * (`rebaseBeforePush`) still runs so users see what a real push would see,
 * and `remapPush` / `remapExtrasPush` run with `dryRun: true` (no copies
 * into `shared/`). The `git add` / `git commit` / `git push` steps are
 * skipped. Instead, `previewPushLeaks` runs a READ-ONLY gitleaks leak
 * preview against a temp copy of the would-be-staged sessions, extras, AND
 * user skills (no `REPO_HOME/shared` mutation), returning a structured verdict
 * whose `verdictRow` lands in the Leak scan section and whose `recovery` (if
 * any) prints below the tree; `process.exitCode = 1` is set on findings.
 *
 * Dry-run skills leak parity: `previewPushLeaks` stages non-gsd user skills
 * into its throwaway tree (`stageSkills`, mirroring `syncSkillsPush`) and scans
 * them, so a secret in a skill file is caught by `nomad push --dry-run` at the
 * same fidelity as a real push, without any `shared/skills/` mutation. The
 * zero-mutation dry-run contract still holds: `syncSkillsPush()` (the real
 * `shared/skills/` write) remains gated behind `if (!dryRun)`, so the dry-run
 * "Global config" section still does NOT list pending skills edits (a
 * presentation gap, not a scan gap).
 *
 * The dry-run preview runs REGARDLESS of `REPO_HOME` `git status`: in dry-run
 * nothing is copied into `shared/`, so an empty status is the normal case for
 * the headline target (a clean repo with new mapped sessions). `previewPushLeaks`
 * stages its own temp tree from the path-map, so the empty-status
 * `'nothing to commit'` early return is REAL-PUSH-ONLY. A dry-run with NO
 * path-map renders the no-scan tree and returns without dying (a real push with
 * a non-empty status and no map still dies on the allow-list check). The
 * allow-list still classifies a non-empty `git status` (dry or wet) so a
 * pre-existing violation surfaces; an empty status has nothing to classify.
 * Mirrors `cmdPull`'s `dryRun` contract.
 *
 * `opts.compose` (default `false`, wet-only; a dry-run never sets it): when
 * `true`, a composing caller (`nomad sync`) owns the render. The
 * `push on host=...` header and the `nothing to commit` log are suppressed,
 * the clean/pushed paths render nothing here, and the returned `nothing`/
 * `pushed` arms carry the built sections instead (see `PushCoreResult`). The
 * leak path still renders its tree inline before the recovery flow (see
 * `commitAndPush`), so the safety pipeline's output is never suppressed.
 *
 * @param opts.dryRun - Preview mode; see above.
 * @param opts.redactAll - Non-interactive leak resolution: redact every finding.
 * @param opts.allowAll - Non-interactive leak resolution: allow every finding.
 * @param opts.allowRule - Non-interactive leak resolution: allow one rule.
 * @param opts.fullScan - When `true`, ignore the per-host manifest and rescan
 *   all mapped transcripts.
 * @param opts.compose - Composing-caller render mode; see above.
 * @returns A `PushCoreResult` tagged `nothing`, `dry`, or `pushed`.
 */
export async function runPushCore(
  opts: {
    dryRun?: boolean;
    redactAll?: boolean;
    allowAll?: boolean;
    allowRule?: string;
    fullScan?: boolean;
    compose?: boolean;
  } = {},
): Promise<PushCoreResult> {
  const dryRun = opts.dryRun === true;
  const redactAll = opts.redactAll === true;
  const allowAll = opts.allowAll === true;
  const allowRule = opts.allowRule;
  const fullScan = opts.fullScan === true;
  const compose = opts.compose === true;
  // Resolution-mode mutual-exclusion guard lives HERE, not in `cmdPush`, so the
  // `cmdSync` compose seam (which calls `runPushCore` directly, bypassing
  // `cmdPush`) cannot forward a conflicting flag combination past the check.
  // Runs before any mutation.
  guardResolutionModeConflicts(dryRun, redactAll, allowAll, allowRule);
  // Standalone push renders inline; a composing caller renders the returned
  // sections itself.
  const render = !compose;
  // Resolve roots once per function entry (mirrors the convention used by
  // every other command/extras/remap module in this codebase).
  const repo = repoHome();
  const backup = backupBase();
  if (!compose) {
    console.log(dryRun ? `push on host=${HOST} (dry-run)` : `push on host=${HOST}`);
  }
  // Non-mutating ahead-drift check: inform before the pipeline mutates anything.
  // Best-effort: a missing or malformed settings.json is silently skipped.
  reportSettingsAheadDrift(repo);
  // Probe at top of flow: fail fast if gitleaks is missing, before any mutation.
  // Capture the version string for the manifest's scanner-version trigger.
  const scannerVersion = probeGitleaks();
  // Compute the config identity hash and read the prior manifest. A missing or
  // malformed manifest is treated as a cold start (full rescan). Load the
  // path-map now so the same instance drives both selection and allow-list
  // enforcement; a missing map sets map=null (handled below).
  const configHash = computeConfigHash();
  const old = readManifest(manifestPath());
  const mapPath = join(repo, 'path-map.json');
  const { map, selection, newManifest } = loadSelectionForPush(
    mapPath,
    old,
    scannerVersion,
    configHash,
    fullScan,
  );
  // Rebase BEFORE any local mutation: surfaces remote conflicts against the
  // user's committed state, not against in-flight remapPush copies. Runs
  // under dryRun too so the network round-trip mirrors a real push.
  withSpinner('Rebasing onto origin', () => rebaseBeforePush(repo));
  // Collision-resistant ts for remapPush's pre-copy snapshot of repo-side state.
  const ts = freshBackupTs(backup);
  // remapPush runs BEFORE the empty-status check: it produces the diffs status
  // observes, so swapping the order would short-circuit before anything is staged.
  // Wrapped in a spinner: the recursive cpSync session copy is the longest
  // blocking step in a push and otherwise shows no progress. The selection
  // drives which files are copied; unchanged files are left at their existing
  // inode so git's stat-cache stays valid.
  const remap = withSpinner('Syncing sessions', () => remapPush(ts, { dryRun, selection }));
  // remapExtrasPush lands between remapPush and findGitlinks so the
  // produced `shared/extras/<logical>/<dirname>/` paths are visible to
  // both the gitlink walk and the downstream allow-list classification.
  // dryRun is forwarded so a preview push reports the same skipped count.
  const extras = withSpinner('Syncing extras', () => remapExtrasPush(ts, { dryRun }));
  // syncSkillsPush and syncSharedLinksPush run between remapExtrasPush and
  // guardGitlinks so the shared/skills and shared/<name> content they produce
  // is visible to both the gitlink walk and the downstream allow-list
  // classification. dryRun is forwarded: under dryRun, neither writes
  // anything (mirroring remapPush/remapExtrasPush). syncSharedLinksPush is a
  // win32-only mirror (it returns immediately on darwin/linux and when
  // path-map.json is absent), so it is safe to call unconditionally here.
  // All steps are real-push-only (zero-mutation dry-run contract). Run them
  // together so their shared !dryRun guard counts as one branch in sonarjs.
  // stripGsdHooksFromBase runs BEFORE the status snapshot (below) so a host
  // whose only outstanding change is a dirty base (gsd entries from an earlier
  // era) creates its own pending change and is not short-circuited by the
  // empty-status early return. The rewritten base is on PUSH_ALLOWED_STATIC so
  // no allow-list change is needed. Both calls are idempotent.
  if (!dryRun) {
    syncSkillsPush();
    syncSharedLinksPush(map);
    stripGsdHooksFromBase(repo, backup);
  }
  const st: PushState = { dryRun, remap, extras, globalConfig: [] };
  guardGitlinks(repo);
  // Routed through the shell-free, untrimmed helper because `sh` would .trim()
  // the leading status-space and shift parsePorcelainZ's offsets.
  // `untrackedAll` (issue #111): the allow-list runs on this snapshot BEFORE
  // `git add -A`. Without it, a fresh host whose entire `shared/extras/`
  // subtree is untracked yields a single collapsed `?? shared/extras/`
  // record that the `shared/extras/<logical>/<dirname>/` child prefix cannot
  // match, so the first extras push is rejected. Expanding to per-file paths
  // lets the existing allow-list accept them while keeping the gate order.
  const status = gitStatusPorcelainZ(repo, { untrackedAll: true });
  // REAL-PUSH-ONLY early return: a dry-run copies nothing into shared/, so an
  // empty status is the normal headline case (clean repo, new mapped
  // sessions) and must still reach the dry-run preview below.
  if (!dryRun && !status) return emptyStatusResult(st, compose, repo);
  // A dry-run with no map cannot enforce nor scan: render the no-scan tree and
  // return without dying. A real push with a non-empty status still dies.
  if (map === null) {
    if (dryRun) {
      runDryRunPreview(st, null, repo, selection);
      return { tag: 'dry' };
    }
    return die('path-map.json missing, cannot enforce push allow-list');
  }
  // Classify only a non-empty status; an empty status (dry-run on a clean
  // repo) has nothing to gate.
  if (status) enforceAllowList(status, map);
  // dryRun skips git add / commit / push: run the read-only leak preview,
  // which prints any recovery below the rendered tree. The manifest is never
  // written on a dry-run.
  if (dryRun) {
    runDryRunPreview(st, map, repo, selection);
    return { tag: 'dry' };
  }
  // commitAndPush reports whether it actually committed and pushed: the
  // gsd-only staged payload short-circuits inside it as a no-op, and a
  // composing caller (nomad sync) must not label that run 'pushed'. Under
  // compose (render === false) it returns the built sections unrendered so
  // the composing caller owns the single merged render.
  const { outcome, sections } = await commitAndPush(
    st,
    ts,
    map,
    { redactAll, allowAll, allowRule },
    repo,
    newManifest,
    render,
  );
  return toPushCoreResult(outcome, sections, compose, repo, st);
}

/**
 * `nomad push` command. Acquires the lock, delegates the entire push side
 * effect chain to `runPushCore`, and releases the lock. Output and exit
 * codes are unchanged from before the `runPushCore` extraction; the wrapper
 * discards `runPushCore`'s return tag since standalone push has already
 * produced every side effect (rendering included) by the time it returns.
 *
 * Any `NomadFatal` thrown by `runPushCore` is caught here so `finally`
 * releases the lock; a real-push leak re-raises the recovery body as a
 * `NomadFatal` AFTER the tree renders (inside `runPushCore`) so the recovery
 * block follows the tree.
 */
export async function cmdPush(
  opts: {
    dryRun?: boolean;
    redactAll?: boolean;
    allowAll?: boolean;
    allowRule?: string;
    /** When `true`, ignore the per-host manifest and rescan all mapped transcripts. */
    fullScan?: boolean;
  } = {},
): Promise<void> {
  // Defense-in-depth: guard resolution-mode conflicts here too, BEFORE the repo
  // check and lock acquisition, so a conflicting flag combination is reported
  // even when the repo is missing or another push holds the lock (in which case
  // `runPushCore`, which carries the same guard for the `cmdSync` compose seam,
  // is never reached). The guard is pure and idempotent, so running it twice on
  // the standalone path is harmless.
  guardResolutionModeConflicts(
    opts.dryRun === true,
    opts.redactAll === true,
    opts.allowAll === true,
    opts.allowRule,
  );
  // Resolve roots once per command invocation (TOCTOU mitigation).
  const repo = repoHome();
  if (!existsSync(repo)) die(`repo not cloned at ${repo}`);
  const handle = acquireLock('push');
  if (handle === null) process.exit(0);
  try {
    await runPushCore(opts);
  } catch (err) {
    if (err instanceof NomadFatal) {
      fail(err.message);
      process.exitCode = err.code;
    } else {
      throw err;
    }
  } finally {
    releaseLock(handle);
  }
}
