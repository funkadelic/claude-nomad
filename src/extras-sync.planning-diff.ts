import { join, normalize, sep } from 'node:path';

import { assertSafeLocalRoot, assertSafeLogical } from './extras-sync.guards.ts';
import { NomadFatal } from './utils.ts';

/**
 * Parsed result of `git diff --name-status -z` output, split into
 * repo-relative paths that were added/modified (changed) and paths that
 * were removed (deleted).
 */
export interface PlanningDiffResult {
  /** Repo-relative paths added or modified (A, M, rename new-name, copy dst). */
  changed: string[];
  /** Repo-relative paths deleted (D, rename old-name). */
  deleted: string[];
}

/**
 * Process one field token from a NUL-split `git diff --name-status -z`
 * field array starting at index `i`, classifying paths into `changed` or
 * `deleted`. Returns the next index to read from.
 *
 * @param fields - All NUL-split tokens from the raw git output.
 * @param i - Index of the status token to process.
 * @param changed - Accumulator for added/modified paths.
 * @param deleted - Accumulator for deleted paths.
 * @returns The index of the next status token after consuming this record.
 */
function processRecord(fields: string[], i: number, changed: string[], deleted: string[]): number {
  const status = fields[i];
  const next = i + 1;

  if (status.startsWith('R')) {
    // Rename: two-field record. Old-name -> deleted, new-name -> changed.
    const oldPath = fields[next];
    const newPath = fields[next + 1];
    if (oldPath) deleted.push(oldPath);
    if (newPath) changed.push(newPath);
    return next + 2;
  }

  if (status.startsWith('C')) {
    // Copy: two-field record. Src is NOT deleted; dst -> changed.
    const dstPath = fields[next + 1];
    if (dstPath) changed.push(dstPath);
    return next + 2;
  }

  // Single-path record: A, M, D, or any other status.
  const path = fields[next];
  if (path) {
    if (status === 'D') {
      deleted.push(path);
    } else {
      changed.push(path);
    }
  }
  return next + 1;
}

/**
 * Parse raw `git diff --name-status -z` output into changed and deleted
 * repo-relative paths.
 *
 * Tokenizes on NUL (`\0`) and walks the field array: reads a status token,
 * then consumes one path field (or two for status starting with `R` or `C`).
 * Classification:
 * - `M`, `A` -> path goes to `changed`
 * - `D` -> path goes to `deleted`
 * - `R...` (rename) -> two-field record: old-name goes to `deleted`,
 *   new-name goes to `changed`
 * - `C...` (copy) -> two-field record: src is NOT deleted, dst goes to
 *   `changed`
 *
 * NUL-delimited parsing means spaces and non-ASCII bytes pass through
 * verbatim with no octal unescaping needed (Phase 41 CR-01 lesson: the
 * quoted-path form is the bug, not the fix).
 *
 * @param raw - The raw, untrimmed stdout from `git diff --name-status -z`.
 * @returns Object with `changed` and `deleted` arrays of repo-relative paths.
 */
export function parsePlanningDiff(raw: string): PlanningDiffResult {
  const changed: string[] = [];
  const deleted: string[] = [];

  if (raw === '') {
    return { changed, deleted };
  }

  const fields = raw.split('\0');
  let i = 0;

  while (i < fields.length) {
    const status = fields[i];
    // Skip empty trailing fields (trailing NUL after the last record).
    if (!status) {
      i++;
      continue;
    }
    i = processRecord(fields, i, changed, deleted);
  }

  return { changed, deleted };
}

/**
 * Derive the host-side absolute paths to delete, given raw `git diff
 * --name-status -z` output, the logical project name, and the host-local
 * project root.
 *
 * Only paths under `shared/extras/<logical>/.planning/` in the repo are
 * considered; others are silently ignored (out of scope for this logical and
 * extra). Each candidate is stripped of the `shared/extras/<logical>/` prefix,
 * joined under `localRoot`, normalized, and asserted to be contained within
 * `localRoot/.planning` (plus separator boundary) before being returned.
 * A path that resolves outside that boundary (e.g. via a crafted `..` segment
 * in repo history) throws `NomadFatal` and is NEVER returned.
 *
 * Guard order: `assertSafeLogical(logical)` and
 * `assertSafeLocalRoot(localRoot, logical)` run up front -- FATAL before any
 * path is returned.
 *
 * @param opts.raw - Raw `git diff --name-status -z` output.
 * @param opts.logical - The path-map.json logical project name (e.g. `my-proj`).
 * @param opts.localRoot - The host-side absolute project root (e.g. `/home/user/my-proj`).
 * @returns Array of absolute host-side paths to delete, all contained within
 *   `localRoot/.planning/`.
 */
export function planningDeleteTargets(opts: {
  raw: string;
  logical: string;
  localRoot: string;
}): string[] {
  const { raw, logical, localRoot } = opts;

  // FATAL before any path derivation: guards must run first.
  assertSafeLogical(logical);
  assertSafeLocalRoot(localRoot, logical);

  const { deleted } = parsePlanningDiff(raw);

  // Repo-relative prefix for .planning files belonging to this logical.
  // Use forward-slash for repo-relative comparison (git paths always use /).
  const logicalPrefix = 'shared/extras/' + logical + '/';
  const prefix = logicalPrefix + '.planning/';
  // The containment boundary: every returned path must start with this.
  const planningRoot = join(localRoot, '.planning');
  const planningRootBoundary = planningRoot + sep;

  const targets: string[] = [];

  for (const repoPath of deleted) {
    if (!repoPath.startsWith(prefix)) {
      // Path is under a different logical or a different extra -- ignore.
      continue;
    }

    // Strip the shared/extras/<logical>/ prefix, leaving .planning/<rel>.
    const remainder = repoPath.slice(logicalPrefix.length);
    // Join the remainder (starting with .planning/) under localRoot.
    const candidate = join(localRoot, remainder);
    // Normalize to resolve any .. segments introduced by crafted repo content.
    const resolved = normalize(candidate);

    // Containment check: the resolved path must be within localRoot/.planning/.
    // Use the sep-terminated boundary to prevent prefix-lookalike attacks
    // (e.g. localRoot/.planningX/ would share the prefix without the sep guard).
    if (resolved !== planningRoot && !resolved.startsWith(planningRootBoundary)) {
      throw new NomadFatal(
        `planningDeleteTargets: resolved path ${JSON.stringify(resolved)} escapes localRoot/.planning for logical ${JSON.stringify(logical)} -- refusing delete`,
      );
    }

    targets.push(resolved);
  }

  return targets;
}
