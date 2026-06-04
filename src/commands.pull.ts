import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildExtrasSection,
  buildSessionsSection,
  buildSettingsSection,
} from './commands.push.sections.ts';
import { BACKUP_BASE, HOST, REPO_HOME, type PathMap } from './config.ts';
import { divergenceCheckExtras, remapExtrasPull } from './extras-sync.ts';
import { applySharedLinks, regenerateSettings } from './links.ts';
import { renderTree, section, addItem } from './output-tree.ts';
import { computePreview } from './preview.ts';
import { remapPull } from './remap.ts';
import { withSpinner } from './spinner.ts';
import { summaryRow } from './summary.ts';
import { detectWedge } from './commands.pull.wedge.ts';
import { die, fail, gitOrFatal, log, NomadFatal } from './utils.ts';
import { freshBackupTs } from './utils.fs.ts';
import { acquireLock, releaseLock } from './utils.lockfile.ts';
import { readPathMap } from './utils.json.ts';

/**
 * Run the WET (non-dry-run) pull side effects in order and render the
 * doctor-style grouped tree once at the end: a `pull on host=... (backup=<ts>)`
 * header followed by `Settings` / `Sessions` / `Extras` / `Summary` sections.
 * `applySharedLinks` stays silent (no Links group by design);
 * `regenerateSettings` returns its override-source label so the Settings row
 * surfaces what was written without logging inline. Sessions/Extras reuse the
 * verb-agnostic builders shared with `cmdPush`, fed the pull-side `pulled`
 * detail arrays. The combined session + extras unmapped count and the
 * extras-skipped count drive the Summary row exactly as `emitSummary` did.
 *
 * @param ts - backup timestamp namespace shared by every WET side effect.
 */
function applyWetPull(ts: string, map: PathMap): void {
  applySharedLinks(ts, map);
  const { label } = regenerateSettings(ts);
  const remapResult = withSpinner('Syncing sessions', () => remapPull(ts));
  const extrasResult = remapExtrasPull(ts);
  // Combine session-unmapped and extras-unmapped into one user-visible count;
  // from the operator's perspective both mean "couldn't sync this for the
  // host". extras-skipped (non-whitelisted dirname) stays separate because it
  // signals config misuse, not a host-config gap.
  const summary = section('Summary');
  addItem(
    summary,
    summaryRow('pull', remapResult.unmapped + extrasResult.unmapped, 0, extrasResult.skipped),
  );
  renderTree([
    buildSettingsSection(label),
    buildSessionsSection(remapResult.pulled, remapResult.unmapped),
    buildExtrasSection(extrasResult.pulled, extrasResult.skipped),
    summary,
  ]);
}

/**
 * Die with an actionable message if `REPO_HOME` is wedged mid-rebase or
 * mid-merge. Called inside the `cmdPull` try block so `NomadFatal` propagates
 * to the existing catch and the lock is released in `finally`. No-op when the
 * repo is clean.
 *
 * @param repo Absolute path to `REPO_HOME`.
 */
function dieIfWedged(repo: string): void {
  const wedge = detectWedge(repo);
  if (wedge === null) return;
  const state = wedge === 'rebase' ? 'mid-rebase' : 'mid-merge';
  die(
    `repo is ${state} from a previous failed pull; ` +
      `run 'nomad pull --force-remote' to auto-recover, ` +
      `or resolve manually (see FAQ: "Every pull fails with unmerged files")`,
  );
}

/**
 * `nomad pull` command. Acquires the push/pull lock, takes a backup
 * timestamp, runs `git pull --rebase --autostash` in `REPO_HOME`, then
 * applies the side-effecting sync steps in order:
 *   1. `divergenceCheckExtras` (read-only WARN naming local files that
 *      diverge from origin; fires in BOTH wet and dry modes per D-08)
 *   2. `applySharedLinks` (symlink shared/* into ~/.claude/)
 *   3. `regenerateSettings` (deep-merge base + host-override into settings.json)
 *   4. `remapPull` (copy repo-side session transcripts into host-encoded dirs)
 *   5. `remapExtrasPull` (copy `shared/extras/<logical>/<dirname>/` back
 *      into each project's localRoot; SKIPPED under dryRun)
 *
 * WET output is a doctor-style grouped tree (`applyWetPull`): a `pull on
 * host=... (backup=<ts>)` header, then `Settings` / `Sessions` / `Extras` /
 * `Summary` sections rendered with `├`/`└` connectors. The Settings row shows
 * `✓ settings.json (base + <label>)`; pulled sessions and extras list as `✓`
 * rows; the per-project "not in path-map" skips collapse to one `ℹ︎` count
 * row. There is no Links group (`applySharedLinks` stays silent by design).
 *
 * The WET-path Summary row (including the warn glyph case) renders to STDOUT as
 * part of the grouped tree via `renderTree`, not to stderr via `warn` as in the
 * pre-tree behavior. The dry-run path still routes its summary through
 * `emitSummary` (stderr). This wet-stdout/dry-stderr stream split is
 * intentional (the dry-run output is left byte-identical) and not a regression.
 *
 * `opts.dryRun` (default `false`): when `true`, the lock IS still acquired
 * and `git pull --rebase` still runs (so concurrent invocations cannot race
 * and the user sees the same network round-trip as a real pull).
 * `divergenceCheckExtras` still fires (read-only by design). Then
 * `computePreview` runs in place of the four mutating steps and renders the
 * full glyph-free tree (Symlinks / settings.json / Sessions / Summary) via
 * `renderTree`. The per-run backup directory under
 * `~/.cache/claude-nomad/backup/<ts>/` is intentionally NOT created (no
 * backups are written under dryRun and an empty dir would pollute the cache).
 *
 * Any `NomadFatal` thrown along the way is caught here so the `finally` block
 * releases the lock before exit (a raw `process.exit()` would skip `finally`
 * and leak the lock, see `NomadFatal` JSDoc). Non-fatal errors rethrow.
 */
export function cmdPull(opts: { dryRun?: boolean } = {}): void {
  const dryRun = opts.dryRun === true;
  if (!existsSync(REPO_HOME)) die(`repo not cloned at ${REPO_HOME}`);
  // Fire the init-hint FATAL BEFORE acquireLock so an
  // unscaffolded repo never creates a lock file. Keyed off the same signal
  // regenerateSettings uses (shared/settings.base.json), so the two entry
  // points share one phrasing instead of diverging on edits.
  if (!existsSync(join(REPO_HOME, 'shared', 'settings.base.json'))) {
    die("repo not initialized; run 'nomad init' to scaffold");
  }
  const handle = acquireLock('pull');
  if (handle === null) process.exit(0);
  try {
    // Collision-resistant ts: nowTimestamp() is second-resolution, so two
    // pulls in the same wall-clock second would share `ts` and the second's
    // backupBeforeWrite calls (cpSync force:false) would silently no-op.
    const ts = freshBackupTs(BACKUP_BASE);
    // Preflight: refuse early if REPO_HOME is stuck mid-rebase or mid-merge.
    // dieIfWedged throws NomadFatal (via die()), caught below so the finally
    // block releases the lock. No backup dir or git pull runs before this check.
    dieIfWedged(REPO_HOME);
    if (!dryRun) {
      // Fail-fast: create backup root BEFORE any mutation. If mkdir fails
      // (out of disk, permission denied), die() throws (NomadFatal) and the
      // outer catch logs + sets exitCode, then finally releases the lock.
      // Skipped under dryRun: no backups are written, and an empty
      // backup-root dir would pollute the cache.
      const backupRoot = join(BACKUP_BASE, ts);
      try {
        mkdirSync(backupRoot, { recursive: true });
      } catch (err) {
        die(`could not create backup dir: ${(err as Error).message}`);
      }
    }
    // WET header becomes the tree header (no `pulling`/`ℹ︎` prefix). The
    // dry-run header phrasing is LEFT byte-identical so the readable diff path
    // does not regress.
    log(
      dryRun
        ? `pulling on host=${HOST} (backup=${ts}; dry-run)`
        : `pull on host=${HOST} (backup=${ts})`,
    );
    gitOrFatal(['pull', '--rebase', '--autostash'], 'git pull --rebase', REPO_HOME);
    // Read path-map.json for sharedDirs/symlink threading. Falls back to a
    // no-sharedDirs map when the file is absent (fresh-clone before init).
    // A parse failure routes through NomadFatal -> catch -> lock release.
    const mapPath = join(REPO_HOME, 'path-map.json');
    const map: PathMap = existsSync(mapPath) ? readPathMap(mapPath) : { projects: {} };
    // Read-only pre-pull check: fires in BOTH wet and dry modes (D-08).
    // Runs AFTER the rebase (so origin content is fetched) and BEFORE any
    // mutation (so local state is intact for byte-level comparison). The
    // function itself silently skips when no `extras` key is declared.
    divergenceCheckExtras(ts);
    if (dryRun) {
      // computePreview renders the full tree including the Summary row with
      // verb='pull'; no separate emitSummary call (it would duplicate the row).
      // dryRun deliberately omits remapExtrasPull to preserve the
      // zero-mutation contract; users still see the divergence WARN above.
      computePreview(ts, map, 'pull');
      log('dry-run complete; no mutation');
    } else {
      applyWetPull(ts, map);
    }
  } catch (err) {
    // Catch fatal errors here so the finally block runs and releases the
    // lock. Throwing through process.exit() would skip finally.
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
