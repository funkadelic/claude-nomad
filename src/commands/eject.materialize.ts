/**
 * Per-name classification and materialization primitives for `nomad eject`,
 * split out of `eject.ts` so the orchestration (dry-run/live passes,
 * `cmdEject`) lives beside itself and this half can be read on its own.
 */

import { cpSync, existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';

import { repoHome } from '../core/config.ts';
import { die, item } from '../core/utils.ts';
import { renameAtomicRetry } from '../core/utils.fs.ts';

/**
 * Extract a human-readable message from a caught value: an `Error`'s
 * `.message`, or `String(err)` otherwise.
 */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Classification of a managed name's current state in `~/.claude/`.
 * `absent`: no entry. `skip-real`: a real file/dir, left alone. `materialize`:
 * a valid symlink with an accessible target. `dangling`: target missing,
 * aborts before any mutation.
 */
export type NameClass = 'absent' | 'skip-real' | 'materialize' | 'dangling';

/** lstat-based existence check that does not follow a symlink: a dangling one still reports true. */
function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Classifies a single managed name from what currently occupies `linkPath` (`claudeHome/<name>`). */
export function classifyName(linkPath: string): NameClass {
  if (!lexists(linkPath)) return 'absent';
  if (!lstatSync(linkPath).isSymbolicLink()) return 'skip-real';
  // `existsSync` follows the link; false means dangling.
  if (!existsSync(linkPath)) return 'dangling';
  return 'materialize';
}

/**
 * Resolves the canonical `shared/` root under `repoHome`; eject only owns
 * links that resolve into this tree. A failure here means the checkout is
 * incomplete while symlinks still resolve, a state eject cannot reason
 * about, so it dies with a `nomad pull` hint rather than guessing a source.
 */
export function resolveSharedRoot(repoHomePath: string): string {
  try {
    return realpathSync(join(repoHomePath, 'shared'));
  } catch {
    return die(
      `cannot resolve ${join(repoHomePath, 'shared')} (repo checkout incomplete). ` +
        `run \`nomad pull\` first, then re-run \`nomad eject\``,
    );
  }
}

/**
 * Whether a resolved symlink `target` is a nomad-managed source: strictly
 * inside `sharedRoot` (a child, not `sharedRoot` itself). The trailing
 * separator keeps `/repo/shared-other` from matching `/repo/shared`.
 */
export function isManagedTarget(target: string, sharedRoot: string): boolean {
  return target.startsWith(sharedRoot + sep);
}

/**
 * Materializes one symlink: copy the resolved target to a sibling temp path,
 * remove the symlink, then rename the temp into place. A crash before the
 * removal leaves the symlink intact; after it, re-running eject recovers
 * (idempotent). Skips a target outside `repoHome/shared/` unmutated.
 */
function materializeOne(name: string, linkPath: string, sharedRoot: string): boolean {
  const target = realpathSync(linkPath);
  if (!isManagedTarget(target, sharedRoot)) {
    item(`skipped (not a nomad-managed target): ${name} -> ${target}`);
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
    renameAtomicRetry(tmp, linkPath);
    item(`ejected: ${name}`);
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
 * Renders the `skip-real` report line: posix means eject expected a symlink
 * and found a real file/dir instead; win32's copy-sync model makes a real
 * copy the normal state, so it is worded as already ejected rather than
 * implying a missing symlink.
 */
export function skipRealMessage(name: string): string {
  return process.platform === 'win32'
    ? `already a real copy (win32 copy-sync): ${name}`
    : `skipped (not a symlink): ${name}`;
}

/**
 * Runs {@link materializeOne}, converting any raw fs fault into a NomadFatal
 * with actionable mixed-state context (already materialized names, a
 * do-not-delete-the-repo-yet hint, and that re-running is idempotent).
 */
export function materializeOneOrDie(
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
        `the remaining names are still symlinks; do NOT delete ${repoHome()} yet, ` +
        `fix the cause and re-run \`nomad eject\` (it is idempotent on already-real names)`,
    );
  }
}
