import { cpSync, existsSync, lstatSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';

import { allSharedLinks, BACKUP_BASE, CLAUDE_HOME, REPO_HOME, type PathMap } from './config.ts';
import { die, fail, log } from './utils.ts';
import { readPathMap } from './utils.json.ts';

/**
 * Manual-remainder checklist printed at the end of every successful eject run
 * (live and dry-run). Exported so tests can assert on the exact wording.
 */
export const EJECT_CHECKLIST = [
  'Manual steps remaining to finish leaving claude-nomad on this host:',
  `  1. Uninstall the CLI: npm uninstall -g claude-nomad`,
  `  2. Remove NOMAD_HOST and NOMAD_REPO from your shell rc (~/.zshrc or ~/.bashrc)`,
  `  3. Optionally delete the local sync checkout: rm -rf ${REPO_HOME}`,
  `  4. Optionally delete the private sync repo on GitHub`,
  `  5. Optionally delete the backup cache: rm -rf ${BACKUP_BASE}`,
].join('\n');

/**
 * Production roots for {@link cmdEject}. Hoisted so the parameter default is a
 * shared constant rather than a fresh object literal per call; tests inject
 * temp-dir roots instead.
 */
const DEFAULT_ROOTS = { claudeHome: CLAUDE_HOME, repoHome: REPO_HOME };

/**
 * Classification of a managed name's current state in `~/.claude/`.
 *
 * - `absent`: no entry at the link path (not even a dangling symlink)
 * - `skip-real`: a real file or directory (not a symlink); leave it alone
 * - `materialize`: a valid symlink with an accessible target; can be replaced
 * - `dangling`: a symlink whose target is missing; abort before any mutation
 */
type NameClass = 'absent' | 'skip-real' | 'materialize' | 'dangling';

/**
 * Extract a human-readable message from a caught value. Errors carry their
 * `.message`; anything else is coerced with `String`. Exported so both branches
 * can be unit-tested without forcing a non-Error throw out of `node:fs`.
 *
 * @param err The caught value.
 * @returns The error message or its string coercion.
 */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * lstat-based existence check that does NOT follow symlinks: a dangling symlink
 * at `p` returns true. Used to detect any entry (file, dir, or symlink) at a
 * path without resolving through the link.
 *
 * @param p Absolute path to probe.
 * @returns True when any entry exists at `p`.
 */
function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
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
 * Classify a single managed name based on what is currently at `linkPath`.
 *
 * @param linkPath Absolute path to probe (`claudeHome/<name>`).
 * @returns Classification string.
 */
function classifyName(linkPath: string): NameClass {
  if (!lexists(linkPath)) return 'absent';
  if (!lstatSync(linkPath).isSymbolicLink()) return 'skip-real';
  // `existsSync` follows the link; false means dangling.
  if (!existsSync(linkPath)) return 'dangling';
  return 'materialize';
}

/**
 * Resolve the canonical `shared/` root under `repoHome`. Eject only owns links
 * that resolve into this tree (see {@link isManagedTarget}).
 *
 * A failure here means the repo checkout is incomplete (`shared/` missing) while
 * symlinks still resolve, which is a state eject cannot reason about. Convert it
 * to a NomadFatal with a `nomad pull` hint rather than copying from an unknown
 * source.
 *
 * @param repoHome Absolute path to the nomad repo root.
 * @returns The realpath of `repoHome/shared`.
 */
function resolveSharedRoot(repoHome: string): string {
  try {
    return realpathSync(join(repoHome, 'shared'));
  } catch {
    return die(
      `cannot resolve ${join(repoHome, 'shared')} (repo checkout incomplete). ` +
        `run \`nomad pull\` first, then re-run \`nomad eject\``,
    );
  }
}

/**
 * Decide whether a resolved symlink target is a nomad-managed source: it must
 * live strictly inside `sharedRoot` (a child, not `sharedRoot` itself). Uses a
 * trailing-separator prefix test so `/repo/shared-other` is not mistaken for a
 * child of `/repo/shared`.
 *
 * @param target Realpath the symlink resolves to.
 * @param sharedRoot Realpath of the repo's `shared/` directory.
 * @returns True when `target` is contained under `sharedRoot`.
 */
function isManagedTarget(target: string, sharedRoot: string): boolean {
  return target.startsWith(sharedRoot + sep);
}

/**
 * Materialize one symlink: copy the resolved target to a sibling temp path,
 * remove the symlink, then rename the temp into place.
 *
 * Crash-safety windows: a crash before `rmSync(linkPath)` leaves the original
 * symlink intact (only the temp copy exists, and it is pre-cleaned on the next
 * run by the unique-suffix + pre-clean). After `rmSync` and before `renameSync`
 * the symlink is GONE and the temp holds the only copy; a crash in that narrow
 * window leaves the name missing until eject is re-run (idempotent: re-running
 * re-classifies the absent name and reports it skipped, while already-real names
 * are left alone). After `renameSync` the real copy is in place.
 *
 * The `dereference: true` flag on `cpSync` is the `cp -rL` equivalent that
 * follows symlinks inside the target tree and copies real content.
 *
 * Containment gate: the resolved target must live under `repoHome/shared/`. A
 * managed name that points somewhere else (left by another tool, or a
 * user-redirected link) is reported and skipped without mutation so eject only
 * materializes links it owns.
 *
 * @param name The managed name being materialized (for log messages).
 * @param linkPath Absolute path of the symlink.
 * @param sharedRoot Realpath of the repo's `shared/` directory (containment root).
 * @returns True when the target was materialized; false when skipped as unmanaged.
 */
function materializeOne(name: string, linkPath: string, sharedRoot: string): boolean {
  const target = realpathSync(linkPath);
  if (!isManagedTarget(target, sharedRoot)) {
    log(`skipped (not a nomad-managed target): ${name} -> ${target}`);
    return false;
  }
  const tmp = `${linkPath}.eject.tmp.${process.pid}.${Date.now()}`;
  try {
    // Clear any stale leftover (crash residue, or a type-mismatched dir/file)
    // so cpSync never hits ERR_FS_CP_DIR_TO_NON_DIR.
    rmSync(tmp, { recursive: true, force: true });
    cpSync(target, tmp, {
      recursive: true,
      force: true,
      dereference: true,
      preserveTimestamps: true,
    });
    rmSync(linkPath, { force: true });
    renameSync(tmp, linkPath);
    log(`ejected: ${name}`);
    return true;
  } catch (err) {
    // Clean up the temp on any error before re-throwing.
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; ignore secondary error
    }
    throw err;
  }
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
 */
function previewDryRun(
  names: string[],
  classifications: Map<string, NameClass>,
  claudeHome: string,
  sharedRoot: string,
): void {
  for (const name of names) {
    const cls = classifications.get(name);
    const linkPath = join(claudeHome, name);
    if (cls === 'absent') {
      log(`skipped (absent): ${name}`);
    } else if (cls === 'skip-real') {
      log(`skipped (not a symlink): ${name}`);
    } else {
      previewMaterialize(name, linkPath, sharedRoot);
    }
  }
  log(EJECT_CHECKLIST);
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
    log(`would materialize: ${name} (target now unresolvable; re-run to re-classify)`);
    return;
  }
  if (!isManagedTarget(target, sharedRoot)) {
    log(`skipped (not a nomad-managed target): ${name} -> ${target}`);
    return;
  }
  log(`would materialize: ${name} (copy ${target} -> ${linkPath})`);
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
 */
function runLiveEject(
  names: string[],
  classifications: Map<string, NameClass>,
  claudeHome: string,
  sharedRoot: string,
): void {
  const done: string[] = [];
  let skipped = 0;
  for (const name of names) {
    const cls = classifications.get(name);
    const linkPath = join(claudeHome, name);
    if (cls === 'absent') {
      log(`skipped (absent): ${name}`);
      skipped++;
    } else if (cls === 'skip-real') {
      log(`skipped (not a symlink): ${name}`);
      skipped++;
    } else if (materializeOneOrDie(name, linkPath, sharedRoot, done)) {
      done.push(name);
    } else {
      skipped++;
    }
  }
  log(`materialized ${done.length}, skipped ${skipped}`);
  log(EJECT_CHECKLIST);
}

/**
 * Run {@link materializeOne}, converting any raw fs fault into a NomadFatal with
 * actionable mixed-state context. Extracted from the loop to keep
 * {@link runLiveEject} under the cognitive-complexity gate.
 *
 * @param name The managed name being materialized.
 * @param linkPath Absolute path of the symlink.
 * @param sharedRoot Realpath of the repo's `shared/` directory (containment root).
 * @param done Names already materialized in this run (for the failure message).
 * @returns True when materialized; false when skipped as unmanaged.
 */
function materializeOneOrDie(
  name: string,
  linkPath: string,
  sharedRoot: string,
  done: string[],
): boolean {
  try {
    return materializeOne(name, linkPath, sharedRoot);
  } catch (err) {
    const msg = errMessage(err);
    return die(
      `failed to materialize ${name}: ${msg}. ` +
        `already materialized: ${done.join(', ') || '(none)'}. ` +
        `the remaining names are still symlinks; do NOT delete ${REPO_HOME} yet, ` +
        `fix the cause and re-run \`nomad eject\` (it is idempotent on already-real names)`,
    );
  }
}

/**
 * Materialize every managed symlink under `~/.claude/` into a real dereferenced
 * copy so the host keeps working after `~/claude-nomad/` is deleted and the CLI
 * is uninstalled.
 *
 * Enumeration source is `allSharedLinks(map)` (the authoritative union of
 * `SHARED_LINKS` and validated `sharedDirs` entries). For each name:
 * - Absent: reported as skipped, not created.
 * - Already a real file/dir: reported as skipped, left unchanged.
 * - Valid symlink into `shared/`: replaced with a dereferenced copy (copy-then-swap).
 * - Valid symlink to a target outside `shared/`: reported and skipped (not owned).
 * - Dangling symlink: the whole command aborts with exit 1 before any mutation;
 *   the user is told to run `nomad pull` first.
 *
 * A real `node:fs` fault during the live pass (disk full, EACCES, target removed
 * under us) aborts with exit 1 and a FATAL message naming the failed entry, the
 * names already materialized, and a do-not-delete-the-repo-yet hint.
 *
 * `dryRun: true` previews actions and prints the checklist without writing.
 *
 * @param opts.dryRun When true, log planned actions and return without mutation.
 * @param roots Injected paths for testing (defaults to `CLAUDE_HOME`/`REPO_HOME`).
 */
export function cmdEject(
  opts: { dryRun?: boolean } = {},
  roots: { claudeHome: string; repoHome: string } = DEFAULT_ROOTS,
): void {
  const dryRun = opts.dryRun === true;
  const { claudeHome, repoHome } = roots;

  const map = readMapIfPresent(repoHome);
  const names = allSharedLinks(map);

  // Classify every name upfront; abort before any mutation if any are dangling.
  const classifications = new Map<string, NameClass>();
  for (const name of names) {
    classifications.set(name, classifyName(join(claudeHome, name)));
  }

  const dangling = names.filter((n) => classifications.get(n) === 'dangling');
  if (dangling.length > 0) {
    fail(
      `dangling symlink(s): ${dangling.join(', ')}. ` +
        `run \`nomad pull\` first to restore the missing target, then re-run \`nomad eject\``,
    );
    process.exit(1);
  }

  const sharedRoot = resolveSharedRoot(repoHome);

  if (dryRun) {
    previewDryRun(names, classifications, claudeHome, sharedRoot);
    return;
  }

  // runLiveEject converts every raw fs fault into a NomadFatal (via
  // materializeOneOrDie), so any throw here is a clean fatal: report it and
  // exit 1, matching the dangling-abort exit semantics above.
  try {
    runLiveEject(names, classifications, claudeHome, sharedRoot);
  } catch (err) {
    fail(errMessage(err));
    process.exit(1);
  }
}
