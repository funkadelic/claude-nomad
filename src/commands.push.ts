import { existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { backupBase, claudeHome, HOST, manifestPath, type PathMap, repoHome } from './config.ts';
import {
  buildManifest,
  computeConfigHash,
  diffManifest,
  enumerateSourceFiles,
  hashFile,
  type Manifest,
  type ManifestDiff,
  type ManifestEntry,
  readManifest,
  shouldFullRescan,
  writeManifest,
} from './push-manifest.ts';
import {
  classifySettingsDrift,
  describeSettings,
  partitionByCaptureExclusion,
} from './commands.capture-settings.core.ts';
import { enforceAllowList, isGsdDropped, parsePorcelainZ } from './commands.push.allowlist.ts';
import { resolveLeakFindings } from './commands.push.recovery.ts';
import { type PushState, renderNoScanTree, renderPushTree } from './commands.push.sections.ts';
import { remapExtrasPush } from './extras-sync.ts';
import { baseHasGsdHookEntries, stripGsdHookEntries } from './hooks-filter.ts';
import { syncSkillsPush } from './skills-sync.ts';
import { collectGlobalConfigChanges } from './push-global-config.ts';
import { scanPushVerdict } from './push-leak-verdict.ts';
import { findGitlinks, probeGitleaks, rebaseBeforePush } from './push-checks.ts';
import { previewPushLeaks } from './push-preview.ts';
import { remapPush } from './remap.ts';
import { withSpinner } from './spinner.ts';
import { die, fail, gitOrFatal, gitStatusPorcelainZ, log, NomadFatal, warn } from './utils.ts';
import { backupRepoWrite, freshBackupTs, writeJsonAtomic } from './utils.fs.ts';
import { deepMerge, encodePath, readJson, readPathMap } from './utils.json.ts';
import { acquireLock, releaseLock } from './utils.lockfile.ts';

/**
 * Idempotent gsd-hook strip for the push write-path. Reads
 * `shared/settings.base.json`, applies `stripGsdHookEntries`, and on a real
 * change backs up via `backupRepoWrite` then writes atomically via
 * `writeJsonAtomic`. If the stripped result deep-equals the original (no gsd
 * entries present) the function returns without writing (no backup, no mtime
 * change). Best-effort: a missing or unparseable base is silently skipped.
 *
 * Must only be called on the REAL-push path (!dryRun). The function is
 * push-only by design: pull stays non-destructive per Phase 50 precedent.
 *
 * @param repo - Resolved repo root path for this invocation.
 * @param backup - Resolved backup root path for this invocation.
 */
function stripGsdHooksFromBase(repo: string, backup: string): void {
  const basePath = join(repo, 'shared', 'settings.base.json');
  if (!existsSync(basePath)) return;
  let base: Record<string, unknown>;
  try {
    base = readJson<Record<string, unknown>>(basePath);
  } catch {
    return; // unparseable: skip silently (best-effort)
  }
  // Use the single shared predicate so an empty hooks: {} scaffold is NOT treated
  // as dirty (no gsd entries present means nothing to strip).
  if (!baseHasGsdHookEntries(base)) return;
  const stripped = stripGsdHookEntries(base);
  const ts = freshBackupTs(backup);
  backupRepoWrite(basePath, ts, repo);
  writeJsonAtomic(basePath, stripped);
}

/**
 * Read-only ahead-drift check for the push flow. Loads the repo's base +
 * host settings, computes the expected merge, and compares it against the live
 * `~/.claude/settings.json`. When the live file has keys not present in the
 * merge (the host is AHEAD), emits one `warn` line naming the local-only keys
 * and pointing at `nomad capture-settings`.
 *
 * Only keys capture would actually promote are reported: credential- and
 * secret-bearing keys (`CAPTURE_EXCLUDED_KEYS`) are filtered out, so the warning
 * neither advises an action that would no-op nor names a secret-bearing key.
 *
 * Best-effort and tolerant: any missing file or parse error is a silent skip.
 * Never mutates anything; never sets `process.exitCode`.
 *
 * @param repo - Resolved repo root path for this invocation.
 */
export function reportSettingsAheadDrift(repo: string): void {
  const basePath = join(repo, 'shared', 'settings.base.json');
  if (!existsSync(basePath)) return;
  const settingsPath = join(claudeHome(), 'settings.json');
  if (!existsSync(settingsPath)) return;
  try {
    const base = readJson<Record<string, unknown>>(basePath);
    const hostPath = join(repo, 'hosts', `${HOST}.json`);
    const overrides = existsSync(hostPath) ? readJson<Record<string, unknown>>(hostPath) : {};
    const merged = deepMerge(base, overrides);
    const settings = readJson<Record<string, unknown>>(settingsPath);
    const { ahead } = classifySettingsDrift(merged, settings);
    const { promotable } = partitionByCaptureExclusion(ahead);
    if (promotable.length === 0) return;
    const { phrase, pronoun, verb } = describeSettings(promotable);
    warn(
      `your settings.json has ${phrase} that ${verb} not yet in the repo; ` +
        `run 'nomad capture-settings' to save ${pronoun} (or 'nomad capture-settings --host' for host-specific values).`,
    );
  } catch {
    // Malformed JSON or unreadable file: skip silently (best-effort).
  }
}

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
 * (TTY interactive menu or non-TTY FATAL throw). On a clean
 * scan commits, pushes, and renders the `✓ no leaks` row.
 *
 * @param st - Push state for the tree render.
 * @param ts - Backup timestamp passed to the recovery flow.
 * @param map - Parsed path-map for session path resolution.
 * @param redactAll - When true, redact all findings non-interactively.
 * @param allowAll - When true, allow all findings non-interactively.
 * @param allowRule - When set, allow only findings matching this rule id.
 * @param repo - Resolved repo root path for this invocation.
 * @param newManifest - The manifest to persist after a successful push.
 */
async function commitAndPush(
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
function runDryRunPreview(
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

/**
 * Enumerate all source files across every project in the path-map that has a
 * local directory for this host. Returns a map from absolute source path to
 * current `{size, mtime}` metadata, matching the predicate used by
 * `copyDirJsonlOnly`. An absent or inaccessible project directory is silently
 * skipped.
 *
 * @param map - Parsed path-map, or `null` when `path-map.json` is absent.
 * @returns Map from absolute path to `{size, mtime}`.
 */
function buildCurrentMap(map: PathMap | null): Record<string, { size: number; mtime: number }> {
  const current: Record<string, { size: number; mtime: number }> = {};
  if (map === null) return current;
  const claude = claudeHome();
  for (const [, hostMap] of Object.entries(map.projects)) {
    const localPath = hostMap[HOST];
    if (!localPath) continue;
    // Session transcripts live at ~/.claude/projects/<encodePath(localPath)>/,
    // not at localPath itself. Mirror the same join that remapPush uses.
    const localDir = join(claude, 'projects', encodePath(localPath));
    if (!existsSync(localDir)) continue;
    for (const f of enumerateSourceFiles(localDir)) {
      const st = statSync(f);
      current[f] = { size: st.size, mtime: st.mtimeMs };
    }
  }
  return current;
}

/**
 * Compute the manifest-driven selection for the current push. Enumerates all
 * source files reachable from the path-map, determines whether a full rescan
 * is needed (cold start, scanner version change, config change, or
 * `--full-scan`), and returns the selection (changed and deleted file sets)
 * plus the new manifest ready to persist after a successful push.
 *
 * Changed files are hashed via a shared cache so the hash thunk called inside
 * `diffManifest` and the entry written into the manifest are computed at most
 * once per file. Unchanged files reuse the prior entry hash.
 *
 * @param map - Parsed path-map, or `null` when `path-map.json` is absent.
 * @param old - Previous manifest, or `null` on cold start.
 * @param scannerVersion - Current scanner version from `probeGitleaks()`.
 * @param configHash - Current config identity from `computeConfigHash()`.
 * @param fullScan - `true` when `--full-scan` was passed.
 * @returns `{ selection, newManifest }` ready for remapPush and writeManifest.
 */
export function computePushSelection(
  map: PathMap | null,
  old: Manifest | null,
  scannerVersion: string,
  configHash: string,
  fullScan: boolean,
): { selection: ManifestDiff | undefined; newManifest: Manifest } {
  const current = buildCurrentMap(map);
  const fullRescan = shouldFullRescan(old, scannerVersion, configHash, fullScan);
  const hashCache = new Map<string, string>();
  const cachedHash = (p: string): string => {
    const hit = hashCache.get(p);
    if (hit !== undefined) return hit;
    const h = hashFile(p);
    hashCache.set(p, h);
    return h;
  };
  // `delta` drives manifest hashing for both paths: on a full rescan every file
  // is (re)hashed, on an incremental push only the changed set is.
  const delta: ManifestDiff = fullRescan
    ? { changed: new Set(Object.keys(current)), deleted: [] }
    : diffManifest(old, current, cachedHash);
  const files: Record<string, ManifestEntry> = {};
  for (const [key, meta] of Object.entries(current)) {
    const hash = delta.changed.has(key) ? cachedHash(key) : old!.files[key].hash;
    files[key] = { size: meta.size, mtime: meta.mtime, hash };
  }
  // A full rescan returns NO selection so remapPush and the dry-run preview fall
  // back to the full-directory mirror, which also prunes repo-side files no
  // longer in the source. A populated full-rescan selection (deleted: []) would
  // skip that cleanup and leave stale transcripts behind.
  return {
    selection: fullRescan ? undefined : delta,
    newManifest: buildManifest(files, scannerVersion, configHash),
  };
}

/**
 * Load the path-map and compute the push selection in one step. Tries to read
 * `path-map.json` at `mapPath`; an absent file yields `map = null` and an
 * undefined selection (cold start triggers a full rescan). A malformed JSON file
 * throws `NomadFatal` (caught by `cmdPush`'s try/finally so the lock releases).
 *
 * Extracted from `cmdPush` so the map-load ternary does not push `cmdPush`
 * over the cognitive-complexity-15 gate.
 *
 * @param mapPath - Absolute path to `path-map.json`.
 * @param old - Previous manifest, or `null` on cold start.
 * @param scannerVersion - Current scanner version from `probeGitleaks()`.
 * @param configHash - Current config identity from `computeConfigHash()`.
 * @param fullScan - `true` when `--full-scan` was passed.
 * @returns `{ map, selection, newManifest }` ready for remapPush and writeManifest.
 */
function loadSelectionForPush(
  mapPath: string,
  old: Manifest | null,
  scannerVersion: string,
  configHash: string,
  fullScan: boolean,
): { map: PathMap | null; selection: ManifestDiff | undefined; newManifest: Manifest } {
  const map: PathMap | null = existsSync(mapPath) ? readPathMap(mapPath) : null;
  const { selection, newManifest } = computePushSelection(
    map,
    old,
    scannerVersion,
    configHash,
    fullScan,
  );
  return { map, selection, newManifest };
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
