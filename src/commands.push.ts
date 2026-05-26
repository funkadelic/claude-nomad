import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { HOME, HOST, REPO_HOME } from './config.ts';
import { enforceAllowList } from './commands.push.allowlist.ts';
import { remapExtrasPush } from './extras-sync.ts';
import { findGitlinks, probeGitleaks, rebaseBeforePush } from './push-checks.ts';
import { runGitleaksScan } from './push-gitleaks.ts';
import { remapPush } from './remap.ts';
import { emitSummary } from './summary.ts';
import { die, fail, gitOrFatal, gitStatusPorcelainZ, log, NomadFatal } from './utils.ts';
import { freshBackupTs } from './utils.fs.ts';
import { readPathMap } from './utils.json.ts';
import { acquireLock, releaseLock } from './utils.lockfile.ts';

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
 *   7. `git add -A` -> `runGitleaksScan` on staged tree -> `git commit` -> `git push`
 *
 * The gitleaks scan runs AFTER staging so it sees what would actually be
 * pushed, but BEFORE commit so a detection unwinds cleanly without leaving a
 * commit to amend or revert. Any `NomadFatal` is caught here so `finally`
 * releases the lock.
 *
 * `opts.dryRun` (default `false`): when `true`, the network round-trip
 * (`rebaseBeforePush`) still runs so users see what a real push would see,
 * but `remapPush` runs with `dryRun: true` (no session copies into shared/),
 * and the `git add` / `runGitleaksScan` / `git commit` / `git push` quartet
 * is skipped. The allow-list check still classifies the existing `git
 * status` so a pre-existing violation surfaces before the user thinks
 * everything is fine. Mirrors `cmdPull`'s `dryRun` contract.
 */
export function cmdPush(opts: { dryRun?: boolean } = {}): void {
  const dryRun = opts.dryRun === true;
  if (!existsSync(REPO_HOME)) die(`repo not cloned at ${REPO_HOME}`);
  const handle = acquireLock('push');
  if (handle === null) process.exit(0);
  try {
    log(dryRun ? `pushing on host=${HOST} (dry-run)` : `pushing on host=${HOST}`);
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
    const remapResult = remapPush(ts, { dryRun });
    // remapExtrasPush lands between remapPush and findGitlinks so the
    // produced `shared/extras/<logical>/<dirname>/` paths are visible to
    // both the gitlink walk and the downstream allow-list classification.
    // dryRun is forwarded so a preview push reports the same skipped count.
    const extrasResult = remapExtrasPush(ts, { dryRun });
    // Gitlink walk of shared/ AFTER remapPush so it inspects the post-copy tree.
    // A nested .git copied in from a host's encoded session dir would slip past a
    // pre-remap scan and reach the remote via the shared/projects/<logical>/ prefix.
    // Per-hit FATAL on stderr plus a summarizing throw, mirroring enforceAllowList.
    const sharedDir = join(REPO_HOME, 'shared');
    const gitlinks = findGitlinks(sharedDir);
    if (gitlinks.length > 0) {
      for (const p of gitlinks) {
        const rel = relative(REPO_HOME, p);
        fail(
          `gitlink: ${rel} would push as submodule (run: rm -rf ${rel} or remove the nested repo)`,
        );
      }
      throw new NomadFatal(
        `gitlink trap: ${gitlinks.length} nested .git ${gitlinks.length === 1 ? 'entry' : 'entries'} in shared/; remove before retry`,
      );
    }
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
      // Combine session-unmapped and extras-unmapped into one user-visible
      // count; both mean "couldn't sync this for the host". extras-skipped
      // (non-whitelisted dirname) stays separate because it signals config
      // misuse, not a host-config gap.
      emitSummary(
        'push',
        remapResult.unmapped + extrasResult.unmapped,
        remapResult.collisions,
        extrasResult.skipped,
      );
      return;
    }
    const mapPath = join(REPO_HOME, 'path-map.json');
    if (!existsSync(mapPath)) die('path-map.json missing, cannot enforce push allow-list');
    // readPathMap routes parse failures through NomadFatal so finally releases the lock.
    const map = readPathMap(mapPath);
    enforceAllowList(status, map);
    if (dryRun) {
      // Skip the staging quartet so no commit lands and nothing is pushed.
      // The user has already seen probeGitleaks pass, the rebase result, the
      // remap preview, the gitlink scan, and the allow-list classification.
      log('push: dry-run; skipping git add, gitleaks scan, commit, and push');
      emitSummary(
        'push',
        remapResult.unmapped + extrasResult.unmapped,
        remapResult.collisions,
        extrasResult.skipped,
      );
      return;
    }
    // gitOrFatal uses execFileSync (no shell) so NOMAD_HOST cannot escape quoting.
    gitOrFatal(['add', '-A'], 'git add', REPO_HOME);
    // Gitleaks scan AFTER staging (sees what would push), BEFORE commit (no cleanup
    // needed on detection). The empty-status early return above guarantees the
    // index is non-empty here.
    runGitleaksScan();
    gitOrFatal(['commit', '-m', `chore: sync from ${HOST}`], 'git commit', REPO_HOME);
    gitOrFatal(['push'], 'git push', REPO_HOME);
    log('push complete');
    emitSummary(
      'push',
      remapResult.unmapped + extrasResult.unmapped,
      remapResult.collisions,
      extrasResult.skipped,
    );
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
