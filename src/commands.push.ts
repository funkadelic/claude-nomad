import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { backupBase, HOST, type PathMap, repoHome } from './config.ts';
import { enforceAllowList } from './commands.push.allowlist.ts';
import { resolveLeakFindings } from './commands.push.recovery.ts';
import { type PushState, renderNoScanTree, renderPushTree } from './commands.push.sections.ts';
import { remapExtrasPush } from './extras-sync.ts';
import { scanPushVerdict } from './push-leak-verdict.ts';
import { findGitlinks, probeGitleaks, rebaseBeforePush } from './push-checks.ts';
import { previewPushLeaks } from './push-preview.ts';
import { remapPush } from './remap.ts';
import { withSpinner } from './spinner.ts';
import { die, fail, gitOrFatal, gitStatusPorcelainZ, log, NomadFatal } from './utils.ts';
import { freshBackupTs } from './utils.fs.ts';
import { readPathMap } from './utils.json.ts';
import { acquireLock, releaseLock } from './utils.lockfile.ts';

/**
 * Walk `shared/` for nested `.git` entries copied in from a host's encoded
 * session dir. A gitlink would otherwise push as a submodule via the
 * `shared/projects/<logical>/` prefix. Emits a per-hit FATAL line on stderr and
 * throws a summarizing `NomadFatal` (caught by `cmdPush` so the lock releases).
 * Runs AFTER `remapPush` so it inspects the post-copy tree.
 *
 * @param repo Resolved repo root path for this invocation.
 */
function guardGitlinks(repo: string): void {
  const gitlinks = findGitlinks(join(repo, 'shared'));
  if (gitlinks.length === 0) return;
  for (const p of gitlinks) {
    const rel = relative(repo, p);
    fail(`gitlink: ${rel} would push as submodule (run: rm -rf ${rel} or remove the nested repo)`);
  }
  const noun = gitlinks.length === 1 ? 'entry' : 'entries';
  throw new NomadFatal(
    `gitlink trap: ${gitlinks.length} nested .git ${noun} in shared/; remove before retry`,
  );
}

/**
 * Staged-tree leak gate + commit/push. Stages with `git add -A`, scans, and
 * on a leak renders the ✗ tree row then delegates to `resolveLeakFindings`
 * (TTY interactive menu or non-TTY FATAL throw, D-01 preserved). On a clean
 * scan commits, pushes, and renders the `✓ no leaks` row.
 *
 * @param st - Push state for the tree render.
 * @param ts - Backup timestamp passed to the recovery flow.
 * @param map - Parsed path-map for session path resolution.
 * @param redactAll - When true, redact all findings non-interactively.
 * @param allowAll - When true, allow all findings non-interactively.
 * @param allowRule - When set, allow only findings matching this rule id.
 * @param repo - Resolved repo root path for this invocation.
 */
async function commitAndPush(
  st: PushState,
  ts: string,
  map: PathMap,
  redactAll: boolean,
  allowAll: boolean,
  allowRule: string | undefined,
  repo: string,
): Promise<void> {
  gitOrFatal(['add', '-A'], 'git add', repo);
  let verdict = withSpinner('Scanning for secrets', scanPushVerdict);
  if (verdict.leak) {
    renderPushTree(st, verdict);
    verdict = await resolveLeakFindings(verdict, ts, map, { redactAll, allowAll, allowRule });
  }
  gitOrFatal(['commit', '-m', `chore: sync from ${HOST}`], 'git commit', repo);
  withSpinner('Pushing', () => gitOrFatal(['push'], 'git push', repo));
  renderPushTree(st, verdict);
}

/**
 * Render the dry-run leak-scan tree. With `map === null` (a dry-run with no
 * `path-map.json`) there is nothing to stage, so it renders the no-scan tree
 * with the `noMapHint` row and returns. Otherwise it runs `previewPushLeaks`
 * (which stages its OWN temp
 * tree from the map, independent of `REPO_HOME` status, and sets
 * `process.exitCode = 1` on findings), renders the push tree with the verdict
 * row in the Leak scan section, and prints the recovery body BELOW the tree via
 * `fail` (stderr) when one is present.
 *
 * Extracted from `cmdPush` so the command body and this helper each stay under
 * the sonarjs cognitive-complexity threshold.
 *
 * @param st - The collected push state for the tree render.
 * @param map - The parsed path-map, or `null` when a dry-run has no map.
 */
function runDryRunPreview(st: PushState, map: PathMap | null): void {
  if (map === null) {
    renderNoScanTree(st, { noMapHint: true });
    return;
  }
  const verdict = previewPushLeaks(map);
  renderPushTree(st, verdict);
  if (verdict.recovery !== null) fail(verdict.recovery);
}

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
/**
 * Defense-in-depth guard for push resolution-mode mutual exclusivity.
 * The argv parser already enforces these, but `cmdPush` re-checks as a
 * second gate (mirroring `cmdClean`'s `--older-than`/`--keep` precedent).
 * Calls `die()` on any conflicting combination: two resolution modes together,
 * or any resolution mode (including `--redact-all`) combined with `--dry-run`
 * (a dry-run resolves nothing).
 *
 * @param dryRun True when `--dry-run` was passed.
 * @param redactAll True when `--redact-all` was passed.
 * @param allowAll True when `--allow-all` was passed.
 * @param allowRule Rule id from `--allow <rule>`, or undefined.
 */
function guardResolutionModeConflicts(
  dryRun: boolean,
  redactAll: boolean,
  allowAll: boolean,
  allowRule: string | undefined,
): void {
  const hasAllow = allowAll || allowRule !== undefined;
  const wantsResolution = redactAll || hasAllow;
  if (redactAll && hasAllow) {
    die('--redact-all, --allow-all, and --allow are mutually exclusive resolution modes');
  }
  if (allowAll && allowRule !== undefined) {
    die('--redact-all, --allow-all, and --allow are mutually exclusive resolution modes');
  }
  if (dryRun && wantsResolution) {
    die(
      '--redact-all, --allow-all, and --allow cannot be combined with --dry-run (dry-run resolves nothing)',
    );
  }
}

export async function cmdPush(
  opts: {
    dryRun?: boolean;
    redactAll?: boolean;
    allowAll?: boolean;
    allowRule?: string;
  } = {},
): Promise<void> {
  const dryRun = opts.dryRun === true;
  const redactAll = opts.redactAll === true;
  const allowAll = opts.allowAll === true;
  const allowRule = opts.allowRule;
  guardResolutionModeConflicts(dryRun, redactAll, allowAll, allowRule);
  // Resolve roots once per command invocation (T-45-02 TOCTOU mitigation).
  const repo = repoHome();
  const backup = backupBase();
  if (!existsSync(repo)) die(`repo not cloned at ${repo}`);
  const handle = acquireLock('push');
  if (handle === null) process.exit(0);
  try {
    console.log(dryRun ? `push on host=${HOST} (dry-run)` : `push on host=${HOST}`);
    // Probe at top of flow: fail fast if gitleaks is missing, before any mutation.
    probeGitleaks();
    // Rebase BEFORE any local mutation: surfaces remote conflicts against the
    // user's committed state, not against in-flight remapPush copies. Runs
    // under dryRun too so the network round-trip mirrors a real push.
    withSpinner('Rebasing onto origin', rebaseBeforePush);
    // Collision-resistant ts for remapPush's pre-copy snapshot of repo-side state.
    const ts = freshBackupTs(backup);
    // remapPush runs BEFORE the empty-status check: it produces the diffs status
    // observes, so swapping the order would short-circuit before anything is staged.
    // Wrapped in a spinner: the recursive cpSync session copy is the longest
    // blocking step in a push and otherwise shows no progress.
    const remap = withSpinner('Syncing sessions', () => remapPush(ts, { dryRun }));
    // remapExtrasPush lands between remapPush and findGitlinks so the
    // produced `shared/extras/<logical>/<dirname>/` paths are visible to
    // both the gitlink walk and the downstream allow-list classification.
    // dryRun is forwarded so a preview push reports the same skipped count.
    const extras = withSpinner('Syncing extras', () => remapExtrasPush(ts, { dryRun }));
    const st: PushState = { dryRun, remap, extras };
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
    const mapPath = join(repo, 'path-map.json');
    // A dry-run with no map cannot enforce nor scan: render the no-scan tree and
    // return without dying. A real push with a non-empty status still dies.
    if (!existsSync(mapPath)) {
      if (dryRun) return runDryRunPreview(st, null);
      die('path-map.json missing, cannot enforce push allow-list');
    }
    // readPathMap routes parse failures through NomadFatal so finally releases the lock.
    const map = readPathMap(mapPath);
    // Classify only a non-empty status; an empty status (dry-run on a clean
    // repo) has nothing to gate.
    if (status) enforceAllowList(status, map);
    // dryRun skips git add / commit / push: run the read-only leak preview,
    // which prints any recovery below the rendered tree.
    if (dryRun) return runDryRunPreview(st, map);
    await commitAndPush(st, ts, map, redactAll, allowAll, allowRule, repo);
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
