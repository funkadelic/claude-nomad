/**
 * Propagates upstream `.planning` deletions into the host-side project tree.
 * `remap.ts` runs this after its extras copy loop, on the pull side only.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { eachExtrasTarget, type ExtrasTarget, type ValidatedExtras } from './core.ts';
import { planningDeleteTargets } from './planning-diff.ts';
import { backupExtrasWrite } from '../../core/utils.fs.ts';
import { gitCaptureBuffer, gitCaptureRaw, NomadFatal, warn } from '../../core/utils.ts';

/**
 * Remove now-empty parent directories of `target` up to but not including
 * `planningRoot`. Stops at the first non-empty directory. Silently ignores
 * ENOENT (a sibling delete already removed it).
 */
function pruneEmptyAncestors(target: string, planningRoot: string): void {
  let dir = dirname(target);
  while (dir !== planningRoot && dir.startsWith(planningRoot + sep)) {
    try {
      if (readdirSync(dir).length > 0) break;
      // rmSync requires recursive:true to remove a directory (rmSync with
      // recursive:false maps to unlink(), which fails with EISDIR on dirs).
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* c8 ignore next */
      break; // ENOENT or other I/O error; stop pruning
    }
    dir = dirname(dir);
  }
}

/**
 * Real path of `dir`, or `undefined` when it does not exist. Lets the delete
 * pass's symlink guard tolerate a missing parent or planning root.
 */
function tryRealpath(dir: string): string | undefined {
  try {
    return realpathSync(dir);
  } catch {
    /* c8 ignore next */
    return undefined; // ENOENT: path does not exist
  }
}

/**
 * Whether `parentReal` is `rootReal` or a strict subdirectory of it. Guards
 * `rmSync` against deleting through an intermediate symlink.
 */
function isInsidePlanningRoot(parentReal: string, rootReal: string): boolean {
  return parentReal === rootReal || parentReal.startsWith(rootReal + sep);
}

/**
 * Delete one resolved target after the safety checks pass, then prune empty
 * ancestors up to `planningRoot`. Skips the delete when `repoCounterpart`
 * still exists, since a case-only rename on a case-insensitive filesystem
 * resolves the old name to the new file and deleting would undo the overlay.
 */
function deletePlanningTarget(target: string, planningRoot: string, repoCounterpart: string): void {
  if (existsSync(repoCounterpart)) return;

  // Verify the parent's real path is inside the planning root,
  // guarding against deletion through an intermediate symlink.
  const parentReal = tryRealpath(dirname(target));
  if (parentReal === undefined) return; // parent gone; target already missing
  const rootReal = tryRealpath(planningRoot);
  /* c8 ignore start */
  // Unreachable: planningRoot is an ancestor of dirname(target), so a defined
  // parentReal implies a defined rootReal. Kept as defense-in-depth.
  if (rootReal === undefined) return; // planning root gone; nothing to do
  /* c8 ignore stop */
  if (!isInsidePlanningRoot(parentReal, rootReal)) return;

  rmSync(target, { recursive: true, force: true });
  pruneEmptyAncestors(target, planningRoot);
}

/**
 * Whether the host file at `target` differs from the pre-rebase repo blob at
 * `repoRel`, i.e. a delete-vs-edit conflict that keeps the local copy. Fails
 * safe: a missing local file is `false`, an unreadable one `true`, so an
 * ambiguous read never deletes. Compares bytes, never mtime.
 */
function localDivergesFromPreDelete(
  target: string,
  pre: string,
  repoRel: string,
  repo: string,
): boolean {
  if (!existsSync(target)) return false; // local file gone; nothing to keep
  try {
    const preBlob = gitCaptureBuffer(['show', `${pre}:${repoRel}`], repo);
    return !readFileSync(target).equals(preBlob);
  } catch {
    // The local path changed type (EISDIR) or is unreadable, or the pre blob is
    // missing. Treat as diverged so a delete never proceeds on uncertainty.
    return true;
  }
}

/**
 * The git argv for one logical's `.planning` upstream-deletion diff. Shared by
 * the wet delete pass and the read-only preview so both read the same set.
 */
function planningDiffArgs(pre: string, post: string, logical: string): string[] {
  return ['diff', '--name-status', '-z', pre, post, '--', `shared/extras/${logical}/.planning/`];
}

/** One upstream-deleted `.planning` file: host path, host-relative, and repo-relative forms. */
type DeletePair = { target: string; relToLocal: string; repoRel: string };

/**
 * Map one target's raw `git diff --name-status -z` output to the host paths a
 * pull would delete, each paired with its host-relative and repo-relative
 * (forward-slash, for `git show`) forms. Shared by the wet delete pass and the
 * preview so the two never drift on path derivation.
 */
function deletePairsFor(t: ExtrasTarget, raw: string): DeletePair[] {
  return planningDeleteTargets({ raw, logical: t.logical, localRoot: t.localRoot }).map(
    (target) => {
      const relToLocal = target.slice(t.localRoot.length + sep.length);
      return {
        target,
        relToLocal,
        repoRel: `shared/extras/${t.logical}/${relToLocal.split(sep).join('/')}`,
      };
    },
  );
}

/**
 * The user-facing WARN naming a `.planning` file kept on a delete-vs-edit
 * conflict. Shared by the wet pull and `pull --dry-run`; `dryRun` rewords the
 * backup clause, since a preview writes no backup.
 */
export function keptDeleteWarnLine(logical: string, relToLocal: string, dryRun = false): string {
  const backup = dryRun ? 'will be backed up when you pull' : 'is backed up';
  return (
    `keeping locally-edited ${relToLocal} in ${logical}: deleted upstream but ` +
    `changed locally (push to reconcile; your copy ${backup})`
  );
}

/**
 * Read-only companion to `propagatePlanningDeletes`: the host-relative paths a
 * pull would KEEP rather than delete because the host edited them since the
 * last sync. Mirrors the wet skip decision without mutating, and a git failure
 * yields an empty list rather than throwing.
 */
export function keptDeletePreview(
  v: ValidatedExtras,
  prePostHeads: { pre: string; post: string },
  repo: string,
): { logical: string; relToLocal: string }[] {
  const kept: { logical: string; relToLocal: string }[] = [];
  for (const t of eachExtrasTarget(v, { unmapped: 0, skipped: 0 })) {
    if (t.dirname !== '.planning') continue;
    let raw: string;
    try {
      raw = gitCaptureRaw(planningDiffArgs(prePostHeads.pre, prePostHeads.post, t.logical), repo);
    } catch {
      continue; // tolerant preview: a git failure surfaces nothing rather than throwing
    }
    for (const { target, relToLocal, repoRel } of deletePairsFor(t, raw)) {
      if (localDivergesFromPreDelete(target, prePostHeads.pre, repoRel, repo)) {
        kept.push({ logical: t.logical, relToLocal });
      }
    }
  }
  return kept;
}

/**
 * Remove host-side `.planning` files deleted upstream, per the
 * `git diff --name-status -z <pre> <post>` D set, snapshotting before the
 * first deletion. A file edited locally since the last sync is KEPT with a
 * WARN (push to reconcile); unmodified files are deleted.
 */
export function propagatePlanningDeletes(
  v: ValidatedExtras,
  ts: string,
  prePostHeads: { pre: string; post: string },
  repo: string,
): void {
  const repoExtras = join(repo, 'shared', 'extras');
  for (const t of eachExtrasTarget(v, { unmapped: 0, skipped: 0 })) {
    if (t.dirname !== '.planning') continue;
    let raw: string;
    try {
      raw = gitCaptureRaw(planningDiffArgs(prePostHeads.pre, prePostHeads.post, t.logical), repo);
    } catch (err) {
      const e = err as Error & { stderr?: Buffer };
      /* c8 ignore start -- stderr is always piped to a Buffer here; guard is defensive */
      if (e.stderr) process.stderr.write(e.stderr);
      /* c8 ignore stop */
      throw new NomadFatal(
        `git diff failed while propagating .planning deletes for ${t.logical}; ` +
          `run nomad pull --force-remote to recover`,
      );
    }
    const pairs = deletePairsFor(t, raw);
    if (pairs.length === 0) continue;

    // Snapshot the host-side .planning tree before any delete so locally-
    // diverged edits can be recovered. cpSync force:false makes this
    // idempotent if the overlay already took a snapshot for this ts.
    backupExtrasWrite(join(t.localRoot, t.dirname), ts, t.localRoot);

    const planningRoot = join(t.localRoot, '.planning');
    for (const { target, relToLocal, repoRel } of pairs) {
      // Delete-vs-edit conflict: keep a file the host edited locally since the
      // last sync. The dry-run preview emits the same WARN via
      // keptDeletePreview; the wet pull emits it here.
      if (localDivergesFromPreDelete(target, prePostHeads.pre, repoRel, repo)) {
        warn(keptDeleteWarnLine(t.logical, relToLocal));
        continue;
      }
      deletePlanningTarget(target, planningRoot, join(repoExtras, t.logical, relToLocal));
    }
  }
}
