import { existsSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  allSharedLinks,
  backupBase,
  claudeHome,
  manifestPath,
  repoHome,
  settingsWrittenPath,
  sharedBaselinePath,
  sharedDirEntries,
  type PathMap,
} from '../core/config.ts';
import {
  mayJoinRefusedEntry,
  validateSharedDirEntry,
  type SharedDirRejectionReason,
} from '../core/config.sharedDirs.guard.ts';
import { fail, item, log, warn } from '../core/utils.ts';
import { readPathMap } from '../core/utils.json.ts';
import {
  classifyName,
  errMessage,
  isManagedTarget,
  materializeOneOrDie,
  resolveSharedRoot,
  skipRealMessage,
  type NameClass,
} from './eject.materialize.ts';

export { errMessage };

/** Roots `cmdEject` acts on; `cacheDir` absent means no host records to forget. */
type EjectRoots = { claudeHome: string; repoHome: string; cacheDir?: string };

/**
 * A path as a double-quoted shell argument, with forward slashes on win32 so
 * Git Bash does not eat the backslashes.
 */
function shellPath(p: string): string {
  return `"${process.platform === 'win32' ? p.replaceAll('\\', '/') : p}"`;
}

/**
 * Build the manual-remainder checklist using call-time path values.
 * Exported so tests can assert on the exact wording.
 *
 * @returns The checklist string with current repoHome() and cache-dir values.
 */
export function ejectChecklist(): string {
  return [
    'Manual steps remaining to finish leaving claude-nomad on this host:',
    `  1. Uninstall the CLI: npm uninstall -g claude-nomad`,
    `  2. Remove NOMAD_HOST and NOMAD_REPO from your shell rc (~/.zshrc or ~/.bashrc)`,
    `  3. Optionally delete the local sync checkout: rm -rf ${shellPath(repoHome())}`,
    `  4. Optionally delete the private sync repo on GitHub`,
    `  5. Optionally delete nomad's cache folder, which holds backups and crash reports, once you`,
    `     no longer need the backups in it: rm -rf ${shellPath(dirname(backupBase()))}`,
  ].join('\n');
}

/**
 * Remove this host's sync records (settings written-keys, shared-links
 * baseline, push manifest) from `cacheDir`, so a later setup on this host
 * starts fresh instead of trusting them; the settings record can authorize a
 * pull to delete settings. A removal failure warns and carries on.
 *
 * @param cacheDir The nomad cache folder, or `undefined` to do nothing.
 * @param dryRun When true, only list what would be removed.
 */
function forgetHostRecords(cacheDir: string | undefined, dryRun: boolean): void {
  if (cacheDir === undefined) return;
  for (const record of [settingsWrittenPath(), sharedBaselinePath(), manifestPath()]) {
    const p = join(cacheDir, basename(record));
    if (!existsSync(p)) continue;
    if (dryRun) {
      item(`would remove sync record: ${p}`);
      continue;
    }
    try {
      rmSync(p, { force: true });
      item(`removed sync record: ${p}`);
    } catch (err) {
      warn(`could not remove ${p}: ${errMessage(err)}; delete it by hand`);
    }
  }
}

/**
 * Read `path-map.json` if present; fall back to an empty map when absent.
 *
 * @param repoHome Absolute path to the nomad repo root.
 * @returns The parsed PathMap, or `{ projects: {} }` when path-map.json is absent.
 */
function readMapIfPresent(repoHome: string): PathMap {
  const mapPath = join(repoHome, 'path-map.json');
  return existsSync(mapPath) ? readPathMap(mapPath) : { projects: {} };
}

/**
 * Log a dry-run preview of what eject would do for each name in `names`.
 *
 * The `realpathSync` for a `materialize` entry is guarded: classification ran
 * earlier, so the target can vanish between classify and preview (TOCTOU). On a
 * resolve failure the preview degrades to a best-effort message and continues
 * rather than crashing the safe-preview path. An unmanaged target (resolves
 * outside `shared/`) prints the same skip line the live path would.
 *
 * @param names Managed names to preview.
 * @param classifications Map from name to its NameClass.
 * @param claudeHome Absolute path to the claude config directory.
 * @param sharedRoot Realpath of the repo's `shared/` directory (containment root).
 * @param cacheDir The nomad cache folder, or `undefined` (see {@link forgetHostRecords}).
 */
function previewDryRun(
  names: string[],
  classifications: Map<string, NameClass>,
  claudeHome: string,
  sharedRoot: string,
  cacheDir: string | undefined,
): void {
  for (const name of names) {
    const cls = classifications.get(name);
    const linkPath = join(claudeHome, name);
    if (cls === 'absent') {
      item(`skipped (absent): ${name}`);
    } else if (cls === 'skip-real') {
      item(skipRealMessage(name));
    } else {
      previewMaterialize(name, linkPath, sharedRoot);
    }
  }
  forgetHostRecords(cacheDir, true);
  log(ejectChecklist());
}

/**
 * Render the dry-run line for a single `materialize` entry, guarding the
 * realpath resolution and applying the same containment classification the live
 * path uses so `--dry-run` and live agree.
 *
 * Exported for unit testing of the unresolvable-target branch, which a
 * black-box `cmdEject` call cannot reach (classify and preview resolve the same
 * path in one call, so a realpath that fails in preview was already classified
 * dangling and aborted).
 *
 * @param name The managed name being previewed.
 * @param linkPath Absolute path of the symlink.
 * @param sharedRoot Realpath of the repo's `shared/` directory (containment root).
 */
export function previewMaterialize(name: string, linkPath: string, sharedRoot: string): void {
  let target: string;
  try {
    target = realpathSync(linkPath);
  } catch {
    item(`would materialize: ${name} (target now unresolvable; re-run to re-classify)`);
    return;
  }
  if (!isManagedTarget(target, sharedRoot)) {
    item(`skipped (not a nomad-managed target): ${name} -> ${target}`);
    return;
  }
  item(`would materialize: ${name} (copy ${target} -> ${linkPath})`);
}

/**
 * Perform the live materialization pass for all names in `names`.
 *
 * Each `materializeOne` is wrapped: a raw `node:fs` fault (ENOSPC, EACCES,
 * target vanished, rename collision) is converted to a NomadFatal that names the
 * failed entry, the names already materialized, and tells the user the host is
 * in a mixed state (do NOT delete the repo checkout yet; fix the cause and
 * re-run, which is idempotent on already-real names). A final tally precedes the
 * checklist so a partial run is obvious at a glance.
 *
 * @param names Managed names to process.
 * @param classifications Map from name to its NameClass.
 * @param claudeHome Absolute path to the claude config directory.
 * @param sharedRoot Realpath of the repo's `shared/` directory (containment root).
 * @param cacheDir The nomad cache folder, or `undefined` (see {@link forgetHostRecords}).
 */
function runLiveEject(
  names: string[],
  classifications: Map<string, NameClass>,
  claudeHome: string,
  sharedRoot: string,
  cacheDir: string | undefined,
): void {
  const done: string[] = [];
  let skipped = 0;
  for (const name of names) {
    const cls = classifications.get(name);
    const linkPath = join(claudeHome, name);
    if (cls === 'absent') {
      item(`skipped (absent): ${name}`);
      skipped++;
    } else if (cls === 'skip-real') {
      item(skipRealMessage(name));
      skipped++;
    } else if (materializeOneOrDie(name, linkPath, sharedRoot, done)) {
      done.push(name);
    } else {
      skipped++;
    }
  }
  log(`materialized ${done.length}, skipped ${skipped}`);
  forgetHostRecords(cacheDir, false);
  log(ejectChecklist());
}

/**
 * Rejection reasons whose entries eject still enumerates, because this host may
 * have materialized one under an older, looser guard and the name is safe to
 * join into a filesystem path.
 *
 * Every reason here is tested AFTER `SAFE_SEGMENT`, so reaching it proves the
 * name carries no path separator, `.` or `..`. `not-a-string` and
 * `not-a-segment` are therefore absent: those are the coercion and traversal
 * shapes, and no host ever materialized one, because the guard has refused them
 * since before `sharedDirs` had any other rejection cause. That guarantee is
 * now enforced by the guard for every consumer, not by which reasons this set
 * happens to list.
 *
 * `win32-alias` is deliberately absent, and its absence is not an exclusion:
 * a trailing-dot spelling is admitted, on every platform, by
 * {@link mayJoinRefusedEntry} on the spelling itself, before this set is
 * consulted at all. It is an ordinary distinct directory name that every
 * released nomad accepted and symlinked, and stranding one loses data.
 * Adding it to this set would change nothing: it is already admitted.
 *
 * `never-sync` and `reserved` earn their place for the same reason the
 * credential shape does: the guard folds case, so names an older nomad accepted
 * and symlinked (`Plans`, `Agents`, `Settings.local.json`) are refused now.
 * Enumerating only the credential shape would strand exactly those.
 */
const WIDENED_REASONS: ReadonlySet<SharedDirRejectionReason> = new Set([
  'never-sync',
  'reserved',
  'secret-shaped',
]);

/**
 * The managed names eject must consider on this host: `allSharedLinks(map)`
 * widened with any `sharedDirs` entry the guard refuses for a reason that is
 * still safe to join into a filesystem path.
 *
 * Eject materializes what this host ALREADY has, so its enumeration cannot be
 * the sync-time guard on its own. A name that was accepted when `nomad adopt`
 * ran, and is refused now, still has a live symlink under `~/.claude/`; leaving
 * it out of the enumeration would skip it silently and then tell the user it is
 * safe to delete the repo, destroying their only copy.
 *
 * The widening is by rejection REASON and by SPELLING, never by type.
 * {@link mayJoinRefusedEntry} owns the part no consumer may decide for itself
 * (the coercion and traversal shapes are never joinable, full stop) and takes
 * {@link WIDENED_REASONS} as the part that is legitimately eject's own. That
 * set is an allow-list rather than a deny-list on the unsafe shapes, because
 * a deny-list fails OPEN: a rejection cause added later would be silently
 * joined into a filesystem path until someone noticed.
 * `commands/doctor/checks/pathmap.ts` passes its own
 * narrower set through the same function, which is why the two consumers can
 * differ without the policy living in two places.
 *
 * @param map Parsed `path-map.json` content.
 * @returns The de-duplicated managed names, valid entries first.
 */
export function ejectNames(map: PathMap): string[] {
  const alreadyMaterialized = sharedDirEntries(map).filter((entry): entry is string => {
    if (typeof entry !== 'string') return false;
    const rejection = validateSharedDirEntry(entry);
    return rejection === null || mayJoinRefusedEntry(entry, rejection.reason, WIDENED_REASONS);
  });
  return [...new Set([...allSharedLinks(map), ...alreadyMaterialized])];
}

/**
 * Production default roots for `cmdEject`, resolved at call time (a named
 * builder rather than an object-literal parameter default, S7737).
 *
 * @returns The production roots object, both paths resolved at call time.
 */
function defaultEjectRoots(): EjectRoots {
  return { claudeHome: claudeHome(), repoHome: repoHome(), cacheDir: dirname(backupBase()) };
}

/**
 * Materialize every managed symlink under `~/.claude/` into a real dereferenced
 * copy so the host keeps working after `~/claude-nomad/` is deleted and the CLI
 * is uninstalled.
 *
 * Enumeration source is {@link ejectNames}: the union of `SHARED_LINKS` and
 * validated `sharedDirs` entries, widened with the entries this host may
 * already have materialized under an earlier, looser guard. For each name:
 * - Absent: reported as skipped, not created.
 * - Already a real file/dir: reported as skipped, left unchanged.
 * - Valid symlink into `shared/`: replaced with a dereferenced copy (copy-then-swap).
 * - Valid symlink to a target outside `shared/`: reported and skipped (not owned).
 * - Dangling symlink: the whole command aborts with exit 1 before any mutation.
 *   A base name is told to run `nomad pull` first; a refused name (one this
 *   host already had under a looser guard) is told nomad cannot restore it
 *   and to remove the dead link by hand, since `nomad pull` would not help.
 *
 * A real `node:fs` fault during the live pass (disk full, EACCES, target removed
 * under us) aborts with exit 1 and a FATAL message naming the failed entry, the
 * names already materialized, and a do-not-delete-the-repo-yet hint.
 *
 * Then removes this host's sync records ({@link forgetHostRecords}).
 *
 * `dryRun: true` previews actions and prints the checklist without writing.
 *
 * @param opts.dryRun When true, log planned actions and return without mutation.
 * @param roots Injected paths for testing (defaults to `defaultEjectRoots()`).
 */
export function cmdEject(
  opts: { dryRun?: boolean } = {},
  roots: EjectRoots = defaultEjectRoots(),
): void {
  const dryRun = opts.dryRun === true;
  const { claudeHome, repoHome, cacheDir } = roots;

  const map = readMapIfPresent(repoHome);
  const names = ejectNames(map);

  // Classify every name upfront; abort before any mutation if any are dangling.
  const classifications = new Map<string, NameClass>();
  for (const name of names) {
    classifications.set(name, classifyName(join(claudeHome, name)));
  }

  // ejectNames calls allSharedLinks, which has already printed
  // `... rejected: ...; skipping` for each re-adopted name. Eject does NOT skip
  // those, and that wording is byte-identical to the case where a name really is
  // dropped and the user's only copy is at risk, so reconcile explicitly.
  //
  // Two gates, both load-bearing. Membership in the base set, because the
  // SHARED_LINKS statics are all in RESERVED_SHARED and so fail the guard on
  // their own name: testing the guard alone would print this for CLAUDE.md,
  // commands, rules and my-statusline.cjs on every host. And classification,
  // because the line claims the host HAS the name, which is false for one that
  // is absent and misleading for a real copy that is about to be reported as
  // already ejected.
  const base = new Set(allSharedLinks(map, { quiet: true }));
  for (const name of names) {
    if (base.has(name)) continue;
    if (classifications.get(name) !== 'materialize') continue;
    item(`processing rejected entry already present on this host: ${name}`);
  }

  // A dangling name outside `base` is a refused entry ejectNames widened in:
  // `nomad pull` never restores it (it is refused, not synced), so the base
  // case's advice would send the user in a circle. Split the report instead
  // of aborting with instructions that cannot be followed for this half.
  const dangling = names.filter((n) => classifications.get(n) === 'dangling');
  const danglingBase = dangling.filter((n) => base.has(n));
  const danglingRefused = dangling.filter((n) => !base.has(n));
  if (danglingBase.length > 0) {
    fail(
      `dangling symlink(s): ${danglingBase.join(', ')}. ` +
        `run \`nomad pull\` first to restore the missing target, then re-run \`nomad eject\``,
    );
  }
  if (danglingRefused.length > 0) {
    fail(
      `dangling symlink(s) for a refused name nomad cannot restore: ${danglingRefused.join(', ')}. ` +
        `recover the content by hand if you need it, then remove the dead link and re-run \`nomad eject\``,
    );
  }
  if (dangling.length > 0) {
    process.exit(1);
  }

  const sharedRoot = resolveSharedRoot(repoHome);

  if (dryRun) {
    previewDryRun(names, classifications, claudeHome, sharedRoot, cacheDir);
    return;
  }

  // runLiveEject converts every raw fs fault into a NomadFatal (via
  // materializeOneOrDie), so any throw here is a clean fatal: report it and
  // exit 1, matching the dangling-abort exit semantics above.
  try {
    runLiveEject(names, classifications, claudeHome, sharedRoot, cacheDir);
  } catch (err) {
    fail(errMessage(err));
    process.exit(1);
  }
}
