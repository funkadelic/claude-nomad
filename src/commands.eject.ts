import { cpSync, existsSync, lstatSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { allSharedLinks, BACKUP_BASE, CLAUDE_HOME, REPO_HOME, type PathMap } from './config.ts';
import { fail, log, NomadFatal } from './utils.ts';
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
 * Classification of a managed name's current state in `~/.claude/`.
 *
 * - `absent`: no entry at the link path (not even a dangling symlink)
 * - `skip-real`: a real file or directory (not a symlink); leave it alone
 * - `materialize`: a valid symlink with an accessible target; can be replaced
 * - `dangling`: a symlink whose target is missing; abort before any mutation
 */
type NameClass = 'absent' | 'skip-real' | 'materialize' | 'dangling';

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
 * Materialize one symlink: copy the resolved target to a sibling temp path,
 * remove the symlink, then rename the temp into place. A crash before rename
 * leaves the original symlink intact; after rename the real copy is in place.
 *
 * The `dereference: true` flag on `cpSync` is the `cp -rL` equivalent that
 * follows symlinks inside the target tree and copies real content.
 *
 * @param name The managed name being materialized (for log messages).
 * @param linkPath Absolute path of the symlink.
 */
function materializeOne(name: string, linkPath: string): void {
  const target = realpathSync(linkPath);
  const tmp = `${linkPath}.eject.tmp.${process.pid}`;
  try {
    cpSync(target, tmp, {
      recursive: true,
      force: true,
      dereference: true,
      preserveTimestamps: true,
    });
    rmSync(linkPath, { force: true });
    renameSync(tmp, linkPath);
    log(`ejected: ${name}`);
  } catch (err) {
    // Clean up the temp on any error before re-throwing.
    /* c8 ignore start -- temp cleanup on fs fault; unreachable in normal tests */
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; ignore secondary error
    }
    throw err;
    /* c8 ignore stop */
  }
}

/**
 * Log a dry-run preview of what eject would do for each name in `names`.
 *
 * @param names Managed names to preview.
 * @param classifications Map from name to its NameClass.
 * @param claudeHome Absolute path to the claude config directory.
 */
function previewDryRun(
  names: string[],
  classifications: Map<string, NameClass>,
  claudeHome: string,
): void {
  for (const name of names) {
    const cls = classifications.get(name);
    const linkPath = join(claudeHome, name);
    if (cls === 'absent') {
      log(`skipped (absent): ${name}`);
    } else if (cls === 'skip-real') {
      log(`skipped (not a symlink): ${name}`);
    } else {
      const target = realpathSync(linkPath);
      log(`would materialize: ${name} (copy ${target} -> ${linkPath})`);
    }
  }
  log(EJECT_CHECKLIST);
}

/**
 * Perform the live materialization pass for all names in `names`.
 *
 * @param names Managed names to process.
 * @param classifications Map from name to its NameClass.
 * @param claudeHome Absolute path to the claude config directory.
 */
function runLiveEject(
  names: string[],
  classifications: Map<string, NameClass>,
  claudeHome: string,
): void {
  for (const name of names) {
    const cls = classifications.get(name);
    const linkPath = join(claudeHome, name);
    if (cls === 'absent') {
      log(`skipped (absent): ${name}`);
    } else if (cls === 'skip-real') {
      log(`skipped (not a symlink): ${name}`);
    } else {
      materializeOne(name, linkPath);
    }
  }
  log(EJECT_CHECKLIST);
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
 * - Valid symlink: replaced with a dereferenced copy (copy-then-swap).
 * - Dangling symlink: the whole command aborts with exit 1 before any mutation;
 *   the user is told to run `nomad pull` first.
 *
 * `dryRun: true` previews actions and prints the checklist without writing.
 *
 * @param opts.dryRun When true, log planned actions and return without mutation.
 * @param roots Injected paths for testing (defaults to `CLAUDE_HOME`/`REPO_HOME`).
 */
export function cmdEject(
  opts: { dryRun?: boolean } = {},
  roots: { claudeHome: string; repoHome: string } = {
    claudeHome: CLAUDE_HOME,
    repoHome: REPO_HOME,
  },
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

  if (dryRun) {
    previewDryRun(names, classifications, claudeHome);
    return;
  }

  /* c8 ignore start -- defensive: runLiveEject only throws on fs fault */
  try {
    runLiveEject(names, classifications, claudeHome);
  } catch (err) {
    if (!(err instanceof NomadFatal)) throw err;
    fail(err.message);
    process.exitCode = 1;
  }
  /* c8 ignore stop */
}
