import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { HOME, HOST, REPO_HOME } from './config.ts';
import { enforceAllowList } from './commands.push.allowlist.ts';
import { type PushState, renderNoScanTree, renderPushTree } from './commands.push.sections.ts';
import { remapExtrasPush } from './extras-sync.ts';
import { scanPushVerdict } from './push-leak-verdict.ts';
import { findGitlinks, probeGitleaks, rebaseBeforePush } from './push-checks.ts';
import { previewPushLeaks } from './push-preview.ts';
import { remapPush } from './remap.ts';
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
 */
function guardGitlinks(): void {
  const gitlinks = findGitlinks(join(REPO_HOME, 'shared'));
  if (gitlinks.length === 0) return;
  for (const p of gitlinks) {
    const rel = relative(REPO_HOME, p);
    fail(`gitlink: ${rel} would push as submodule (run: rm -rf ${rel} or remove the nested repo)`);
  }
  const noun = gitlinks.length === 1 ? 'entry' : 'entries';
  throw new NomadFatal(
    `gitlink trap: ${gitlinks.length} nested .git ${noun} in shared/; remove before retry`,
  );
}

/**
 * The staged-tree leak gate + commit/push for the REAL push path. Runs
 * `scanPushVerdict` AFTER `git add -A` (sees what would push) but BEFORE commit
 * (a detection unwinds cleanly with no commit to revert). On a leak it renders
 * the tree (with the ✗ Leak scan row + Summary) so the tree precedes the
 * recovery block, then throws the recovery body as a `NomadFatal` (the catch
 * prints it and sets a non-zero exit). On a clean scan it commits, pushes, and
 * renders the tree with the `✓ no leaks` row.
 *
 * @param st - The collected push state for the final tree render.
 */
function commitAndPush(st: PushState): void {
  // gitOrFatal uses execFileSync (no shell) so NOMAD_HOST cannot escape quoting.
  gitOrFatal(['add', '-A'], 'git add', REPO_HOME);
  const verdict = scanPushVerdict();
  if (verdict.leak) {
    renderPushTree(st, verdict);
    // Every `leak: true` branch of scanPushVerdict sets a non-null recovery
    // body, so the `?? fallback` is defensively unreachable (excluded from
    // coverage rather than contorting a test to fake an impossible state).
    /* c8 ignore next */
    throw new NomadFatal(verdict.recovery ?? 'gitleaks detected secrets');
  }
  gitOrFatal(['commit', '-m', `chore: sync from ${HOST}`], 'git commit', REPO_HOME);
  gitOrFatal(['push'], 'git push', REPO_HOME);
  renderPushTree(st, verdict);
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
 * prints below the tree; `process.exitCode = 1` is set on findings. The
 * allow-list check still classifies the existing `git status` so a
 * pre-existing violation surfaces before the user thinks everything is fine.
 * Mirrors `cmdPull`'s `dryRun` contract.
 */
export function cmdPush(opts: { dryRun?: boolean } = {}): void {
  const dryRun = opts.dryRun === true;
  if (!existsSync(REPO_HOME)) die(`repo not cloned at ${REPO_HOME}`);
  const handle = acquireLock('push');
  if (handle === null) process.exit(0);
  try {
    console.log(dryRun ? `push on host=${HOST} (dry-run)` : `push on host=${HOST}`);
    // Probe at top of flow: fail fast if gitleaks is missing, before any mutation.
    probeGitleaks();
    // Rebase BEFORE any local mutation: surfaces remote conflicts against the
    // user's committed state, not against in-flight remapPush copies. Runs
    // under dryRun too so the network round-trip mirrors a real push.
    rebaseBeforePush();
    // Collision-resistant ts for remapPush's pre-copy snapshot of repo-side state.
    const backupBase = join(HOME, '.cache', 'claude-nomad', 'backup');
    const ts = freshBackupTs(backupBase);
    // remapPush runs BEFORE the empty-status check: it produces the diffs status
    // observes, so swapping the order would short-circuit before anything is staged.
    const remap = remapPush(ts, { dryRun });
    // remapExtrasPush lands between remapPush and findGitlinks so the
    // produced `shared/extras/<logical>/<dirname>/` paths are visible to
    // both the gitlink walk and the downstream allow-list classification.
    // dryRun is forwarded so a preview push reports the same skipped count.
    const extras = remapExtrasPush(ts, { dryRun });
    const st: PushState = { dryRun, remap, extras };
    guardGitlinks();
    // Routed through the shell-free, untrimmed helper because `sh` would .trim()
    // the leading status-space and shift parsePorcelainZ's offsets.
    // `untrackedAll` (issue #111): the allow-list runs on this snapshot BEFORE
    // `git add -A`. Without it, a fresh host whose entire `shared/extras/`
    // subtree is untracked yields a single collapsed `?? shared/extras/`
    // record that the `shared/extras/<logical>/<dirname>/` child prefix cannot
    // match, so the first extras push is rejected. Expanding to per-file paths
    // lets the existing allow-list accept them while keeping the gate order.
    const status = gitStatusPorcelainZ(REPO_HOME, { untrackedAll: true });
    if (!status) {
      log('nothing to commit');
      renderNoScanTree(st);
      return;
    }
    const mapPath = join(REPO_HOME, 'path-map.json');
    if (!existsSync(mapPath)) die('path-map.json missing, cannot enforce push allow-list');
    // readPathMap routes parse failures through NomadFatal so finally releases the lock.
    const map = readPathMap(mapPath);
    enforceAllowList(status, map);
    if (dryRun) {
      // Skip git add / commit / push. previewPushLeaks runs a read-only gitleaks
      // leak preview and RETURNS a structured verdict; its row goes in the tree
      // and its recovery (if any) prints below.
      const verdict = previewPushLeaks(map);
      renderPushTree(st, verdict);
      if (verdict.recovery !== null) fail(verdict.recovery);
      return;
    }
    commitAndPush(st);
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
