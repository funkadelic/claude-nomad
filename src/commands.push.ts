import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { backupBase, HOST, manifestPath, repoHome } from './config.ts';
import { computeConfigHash, readManifest } from './push-manifest.ts';
import { loadSelectionForPush } from './commands.push.selection.ts';
import { enforceAllowList } from './commands.push.allowlist.ts';
import { type PushState, renderNoScanTree } from './commands.push.sections.ts';
import { reportSettingsAheadDrift, stripGsdHooksFromBase } from './commands.push.settings.ts';
import { guardGitlinks, guardResolutionModeConflicts } from './commands.push.guards.ts';
import { commitAndPush, runDryRunPreview } from './commands.push.steps.ts';
import { remapExtrasPush } from './extras-sync.ts';
import { syncSkillsPush } from './skills-sync.ts';
import { probeGitleaks, rebaseBeforePush } from './push-checks.ts';
import { remapPush } from './remap.ts';
import { withSpinner } from './spinner.ts';
import { die, fail, gitStatusPorcelainZ, log, NomadFatal } from './utils.ts';
import { freshBackupTs } from './utils.fs.ts';
import { acquireLock, releaseLock } from './utils.lockfile.ts';

export { reportSettingsAheadDrift } from './commands.push.settings.ts';

/**
 * `nomad push` command. Acquires the lock, runs the four pre-push safety
 * checks in the order from CONTEXT.md, stages, and pushes:
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
 * Output is a doctor-style grouped tree: a `push on host=...` header, then
 * `Sessions` / `Extras` / `Leak scan` / `Summary` sections rendered with
 * `├`/`└` connectors. Pushed sessions and extras list as `✓` rows; the
 * per-project "not in path-map" skips collapse to one `ℹ︎` count row. The Leak
 * scan section shows `✓ no leaks` on a clean scan; on a leak it shows a `✗`
 * one-line verdict row and the full `buildSessionAwareFatal` recovery block
 * still prints BELOW the rendered tree.
 *
 * The WET-path Summary row (including the warn `⚠︎` case) renders to STDOUT as
 * part of the grouped tree via `renderTree`, not to stderr via `warn` as in the
 * pre-tree behavior. The dry-run preview likewise renders via `renderTree`
 * (push has no dry-run `emitSummary` path; `cmdPull`'s dry-run does, see its
 * JSDoc for the intentional wet-stdout/dry-pull-stderr stream split).
 *
 * The gitleaks scan runs AFTER staging so it sees what would actually be
 * pushed, but BEFORE commit so a detection unwinds cleanly without leaving a
 * commit to amend or revert. Any `NomadFatal` is caught here so `finally`
 * releases the lock; a real-push leak re-raises the recovery body as a
 * `NomadFatal` AFTER the tree renders so the recovery block follows the tree.
 *
 * `opts.dryRun` (default `false`): when `true`, the network round-trip
 * (`rebaseBeforePush`) still runs so users see what a real push would see,
 * and `remapPush` / `remapExtrasPush` run with `dryRun: true` (no copies
 * into `shared/`). The `git add` / `git commit` / `git push` steps are
 * skipped. Instead, `previewPushLeaks` runs a READ-ONLY gitleaks leak
 * preview against a temp copy of the would-be-staged sessions AND extras
 * (no `REPO_HOME/shared` mutation), returning a structured verdict whose
 * `verdictRow` lands in the Leak scan section and whose `recovery` (if any)
 * prints below the tree; `process.exitCode = 1` is set on findings.
 *
 * Dry-run skills gap (intentional): `syncSkillsPush()` is gated behind
 * `if (!dryRun)`, so a dry-run mutates nothing under `shared/skills/`. As a
 * result the dry-run "Global config" section (which now treats `shared/skills`
 * as a global-config prefix) does NOT list pending skills edits, and the
 * dry-run leak preview does not scan skills (see `previewPushLeaks`). A real
 * push copies and stages skills, so they appear under Global config and are
 * scanned then. Preserving the zero-mutation dry-run contract is why skills are
 * not surfaced in the preview.
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
  const dryRun = opts.dryRun === true;
  const redactAll = opts.redactAll === true;
  const allowAll = opts.allowAll === true;
  const allowRule = opts.allowRule;
  const fullScan = opts.fullScan === true;
  guardResolutionModeConflicts(dryRun, redactAll, allowAll, allowRule);
  // Resolve roots once per command invocation (TOCTOU mitigation).
  const repo = repoHome();
  const backup = backupBase();
  if (!existsSync(repo)) die(`repo not cloned at ${repo}`);
  const handle = acquireLock('push');
  if (handle === null) process.exit(0);
  try {
    console.log(dryRun ? `push on host=${HOST} (dry-run)` : `push on host=${HOST}`);
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
    // syncSkillsPush runs between remapExtrasPush and guardGitlinks so the
    // produced shared/skills content is visible to both the gitlink walk and
    // the downstream allow-list classification. dryRun is forwarded: under
    // dryRun, copySkillsPush writes nothing (mirroring remapPush/remapExtrasPush).
    // Both steps are real-push-only (zero-mutation dry-run contract). Run them
    // together so their shared !dryRun guard counts as one branch in sonarjs.
    // stripGsdHooksFromBase runs BEFORE the status snapshot (below) so a host
    // whose only outstanding change is a dirty base (gsd entries from an earlier
    // era) creates its own pending change and is not short-circuited by the
    // empty-status early return. The rewritten base is on PUSH_ALLOWED_STATIC so
    // no allow-list change is needed. Both calls are idempotent.
    if (!dryRun) {
      syncSkillsPush();
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
    if (!dryRun && !status) {
      log('nothing to commit');
      renderNoScanTree(st);
      return;
    }
    // A dry-run with no map cannot enforce nor scan: render the no-scan tree and
    // return without dying. A real push with a non-empty status still dies.
    if (map === null) {
      if (dryRun) return runDryRunPreview(st, null, repo, selection);
      return die('path-map.json missing, cannot enforce push allow-list');
    }
    // Classify only a non-empty status; an empty status (dry-run on a clean
    // repo) has nothing to gate.
    if (status) enforceAllowList(status, map);
    // dryRun skips git add / commit / push: run the read-only leak preview,
    // which prints any recovery below the rendered tree. The manifest is never
    // written on a dry-run.
    if (dryRun) return runDryRunPreview(st, map, repo, selection);
    await commitAndPush(st, ts, map, { redactAll, allowAll, allowRule }, repo, newManifest);
  } catch (err) {
    if (err instanceof NomadFatal) {
      fail(err.message);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    releaseLock(handle);
  }
}
