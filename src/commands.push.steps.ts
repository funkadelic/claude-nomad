import { HOST, manifestPath, type PathMap } from './config.ts';
import { type Manifest, type ManifestDiff, writeManifest } from './push-manifest.ts';
import { isGsdDropped, parsePorcelainZ } from './commands.push.allowlist.ts';
import { leakBlockedFatal, resolveLeakFindings } from './commands.push.recovery.ts';
import {
  buildNoScanSections,
  buildPushTreeSections,
  type PushState,
  renderNoScanTree,
  renderPushTree,
} from './commands.push.sections.ts';
import { type DoctorSection, renderTree } from './output-tree.ts';
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
 * `render` controls whether this function prints anything for the
 * clean/pushed paths: `true` (standalone `cmdPush`) renders exactly as before
 * this compose-mode extraction. `false` (a composing caller, e.g. `nomad
 * sync`) suppresses the `nothing to commit` log and both push-tree renders on
 * the clean paths, returning the built sections instead so the caller renders
 * its own merged tree. The leak path is the one exception: it always renders
 * the pre-recovery tree inline (before `resolveLeakFindings`) AND the final
 * post-recovery tree inline, regardless of `render`, because the interactive
 * recovery menu / recovery body needs the tree already visible; the returned
 * `sections` is empty on that path so a composing caller never double-renders.
 * Under `render: false` the leak path additionally prints a one-line
 * `push (leak recovery)` context header first, so the inline push trees are
 * attributable inside the composing caller's transcript (which otherwise
 * prints its own header only later).
 *
 * @param st - Push state for the tree render.
 * @param ts - Backup timestamp passed to the recovery flow.
 * @param map - Parsed path-map for session path resolution.
 * @param resolution - Non-interactive resolution modes (redactAll/allowAll/allowRule).
 * @param repo - Resolved repo root path for this invocation.
 * @param newManifest - The manifest to persist after a successful push.
 * @param render - Whether to render inline (see above).
 * @returns `{ outcome, sections }`: `outcome` is `'pushed'` after a completed
 *   commit/push, `'nothing'` when the gsd payload was the only staged change
 *   and the no-op early return fired (so a composing caller never reports a
 *   push that did not happen); `sections` are the built tree sections for a
 *   composing caller to render (empty on the leak path, already rendered inline).
 */
export async function commitAndPush(
  st: PushState,
  ts: string,
  map: PathMap,
  resolution: { redactAll: boolean; allowAll: boolean; allowRule: string | undefined },
  repo: string,
  newManifest: Manifest,
  render: boolean,
): Promise<{ outcome: 'pushed' | 'nothing'; sections: DoctorSection[] }> {
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
    const sections = buildNoScanSections(st);
    if (render) {
      log('nothing to commit');
      renderTree(sections);
    }
    return { outcome: 'nothing', sections };
  }
  // Collect staged shared-config changes AFTER git add -A so the index reflects
  // the full staged tree. Assigned onto st so renderPushTree sees the section.
  st.globalConfig = collectGlobalConfigChanges(repo, HOST, { staged: true });
  let verdict = withSpinner('Scanning for secrets', () => scanPushVerdict(repo));
  const hadLeak = verdict.leak;
  if (verdict.leak) {
    // A composing caller has not printed any push context yet, so name the
    // flow the detached inline trees below belong to.
    if (!render) log('push (leak recovery)');
    // Unconditional regardless of `render`: the interactive recovery menu /
    // recovery body needs the tree already visible before it prints.
    renderPushTree(st, verdict);
    verdict = await resolveLeakFindings(verdict, ts, map, resolution);
    // Backstop: every recovery path is expected to throw on an unresolved
    // leak, but the value being guarded here is the entire reason the push
    // pipeline exists, so it is re-asserted at the one place that matters,
    // the statement before `git commit`, rather than trusted on the strength
    // of that expectation alone.
    if (verdict.leak) throw leakBlockedFatal(verdict.recovery);
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
  if (hadLeak) {
    // Already rendered the leak tree inline above; render the resolved
    // (post-recovery) tree inline too, unconditionally, so the recovery
    // block still follows it. Return no sections: a composing caller must
    // not render this tree a second time.
    renderPushTree(st, verdict);
    return { outcome: 'pushed', sections: [] };
  }
  const sections = buildPushTreeSections(st, verdict);
  if (render) renderTree(sections);
  return { outcome: 'pushed', sections };
}

/**
 * Render the dry-run leak-scan tree. With `map === null` (a dry-run with no
 * `path-map.json`) there is nothing to stage, so it renders the no-scan tree
 * with the `noMapHint` row and returns. Otherwise it runs `previewPushLeaks`
 * (which stages its OWN temp
 * tree from the map, independent of `REPO_HOME` status, and sets
 * `process.exitCode` to `EXIT.LEAK_BLOCKED` (5) on a leak OR an unscannable
 * staged tree, the scan ran but produced no parseable report, both failing
 * closed like a real push; only a scan that could not run at all, gitleaks or
 * git missing, exits `1`), renders the push tree with the verdict row in the
 * Leak scan
 * section, and prints the recovery body BELOW the tree via `fail` (stderr) when
 * one is present.
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
