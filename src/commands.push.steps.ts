import { HOST, manifestPath, type PathMap } from './config.ts';
import { type Manifest, type ManifestDiff, writeManifest } from './push-manifest.ts';
import { isGsdDropped, parsePorcelainZ } from './commands.push.allowlist.ts';
import { resolveLeakFindings } from './commands.push.recovery.ts';
import { type PushState, renderNoScanTree, renderPushTree } from './commands.push.sections.ts';
import { collectGlobalConfigChanges } from './push-global-config.ts';
import { scanPushVerdict } from './push-leak-verdict.ts';
import { previewPushLeaks } from './push-preview.ts';
import { withSpinner } from './spinner.ts';
import { fail, gitOrFatal, gitStatusPorcelainZ, log, warn } from './utils.ts';

/**
 * Staged-tree leak gate + commit/push. Stages with `git add -A`, scans, and
 * on a leak renders the ✗ tree row then delegates to `resolveLeakFindings`
 * (TTY interactive menu or non-TTY FATAL throw). On a clean
 * scan commits, pushes, and renders the `✓ no leaks` row.
 *
 * @param st - Push state for the tree render.
 * @param ts - Backup timestamp passed to the recovery flow.
 * @param map - Parsed path-map for session path resolution.
 * @param resolution - Non-interactive resolution modes (redactAll/allowAll/allowRule).
 * @param repo - Resolved repo root path for this invocation.
 * @param newManifest - The manifest to persist after a successful push.
 */
export async function commitAndPush(
  st: PushState,
  ts: string,
  map: PathMap,
  resolution: { redactAll: boolean; allowAll: boolean; allowRule: string | undefined },
  repo: string,
  newManifest: Manifest,
): Promise<void> {
  gitOrFatal(['add', '-A'], 'git add', repo);
  // Unstage gsd-dropped paths immediately after staging: gsd reinstalls these
  // per-host automatically, so they must never enter the shared commit. Uses the
  // same isGsdDropped predicate that enforceAllowList uses to skip them, keeping
  // the gate and the commit suppression in sync via a single source of truth.
  const staged = parsePorcelainZ(gitStatusPorcelainZ(repo));
  const toDrop = staged.filter((p) => isGsdDropped(p));
  if (toDrop.length > 0) {
    gitOrFatal(['restore', '--staged', '--', ...toDrop], 'git restore --staged', repo);
  }
  // If the gsd payload was the only staged change, the index is now empty and a
  // commit would fail with "nothing to commit". This is the pure issue #294 case
  // (a host whose sole pending change is gsd's per-host reinstall): render the
  // no-scan tree and return a clean no-op push instead of dying. toDrop is a
  // subset of staged, so equal lengths means every staged path was dropped.
  if (staged.length === toDrop.length) {
    log('nothing to commit');
    renderNoScanTree(st);
    return;
  }
  // Collect staged shared-config changes AFTER git add -A so the index reflects
  // the full staged tree. Assigned onto st so renderPushTree sees the section.
  st.globalConfig = collectGlobalConfigChanges(repo, HOST, { staged: true });
  let verdict = withSpinner('Scanning for secrets', () => scanPushVerdict(repo));
  if (verdict.leak) {
    renderPushTree(st, verdict);
    verdict = await resolveLeakFindings(verdict, ts, map, resolution);
  }
  gitOrFatal(['commit', '-m', `chore: sync from ${HOST}`], 'git commit', repo);
  withSpinner('Pushing', () => gitOrFatal(['push'], 'git push', repo));
  // Persist the manifest only after the push succeeds so a failed or aborted
  // push never marks unscanned files as scanned. The push has already landed
  // remotely, so a manifest-write failure is best-effort: warn but do not fail
  // the command (the worst case is one redundant full rescan next push).
  try {
    writeManifest(manifestPath(), newManifest);
  } catch (err) {
    warn(`could not write push manifest (next push will full-rescan): ${String(err)}`);
  }
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
 * @param repo - Resolved repo root path for collecting global-config changes.
 * @param selection - Manifest-driven selection; passed to previewPushLeaks so the
 *   dry-run scan covers only the same delta a real push would scan. `undefined`
 *   on a full rescan, so the preview stages the whole tree.
 */
export function runDryRunPreview(
  st: PushState,
  map: PathMap | null,
  repo: string,
  selection: ManifestDiff | undefined,
): void {
  // Dry-run stages nothing, so diff against HEAD to capture working-tree changes.
  st.globalConfig = collectGlobalConfigChanges(repo, HOST, { staged: false });
  if (map === null) {
    renderNoScanTree(st, { noMapHint: true });
    return;
  }
  const verdict = withSpinner('Scanning for secrets', () => previewPushLeaks(map, { selection }));
  renderPushTree(st, verdict);
  if (verdict.recovery !== null) fail(verdict.recovery);
}
