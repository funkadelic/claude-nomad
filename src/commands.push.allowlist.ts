import {
  ALWAYS_NEVER_SYNC,
  NEVER_SYNC,
  PUSH_ALLOWED_STATIC,
  SUPPORTED_EXTRAS,
  type PathMap,
} from './config.ts';
import { isValidSharedDir } from './config.sharedDirs.guard.ts';
import { fail, NomadFatal } from './utils.ts';

/**
 * Match `path` against an entry in the push allow-list. Exact match for
 * non-`/`-terminated entries; prefix match for `/`-terminated entries; and
 * a special case for `hosts/`: only `hosts/<name>.json` (single-level,
 * `.json` extension) is allowed, so arbitrary credentials like
 * `hosts/dell-wsl.key` are rejected even though they share the prefix.
 */
function isAllowed(path: string, allowed: readonly string[]): boolean {
  for (const entry of allowed) {
    if (path === entry) return true;
    if (entry === 'hosts/') {
      if (/^hosts\/[^/]+\.json$/.test(path)) return true;
      continue;
    }
    if (entry.endsWith('/') && path.startsWith(entry)) return true;
  }
  return false;
}

/**
 * True when any path segment matches a hard-block entry. Outside the extras
 * tree the full `NEVER_SYNC` set applies. Inside `shared/extras/` only the
 * `ALWAYS_NEVER_SYNC` subset applies (Pitfall 6): the broader set was authored
 * against `~/.claude/` semantics for ephemeral state, so `.planning/todos/` and
 * similar legitimate GSD content must pass, but genuinely-sensitive host-local
 * files (`.credentials.json`, `settings.local.json`, `.claude.json`, ...) stay
 * blocked even when nested inside a synced extras dir.
 */
function isNeverSync(path: string): boolean {
  const blockSet = path.startsWith('shared/extras/') ? ALWAYS_NEVER_SYNC : NEVER_SYNC;
  for (const segment of path.split('/')) {
    if (blockSet.has(segment)) return true;
  }
  return false;
}

/**
 * Parse `git status --porcelain=v1 -z` (NUL-delimited) output into a flat
 * list of paths. Handles rename (`R`) and copy (`C`) records, which span
 * two NUL fields (`XY new\0old\0`): both halves are returned so the
 * allow-list can reject either side. `-z` avoids the quoting that LF
 * porcelain applies to paths containing spaces or specials, which would
 * otherwise cause parser misclassification.
 */
export function parsePorcelainZ(statusPorcelain: string): string[] {
  const records = statusPorcelain.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec === undefined || rec === '') continue;
    // Each record starts with "XY " (2 status chars + 1 space). The path is
    // everything after byte 3. For R/C the NEXT record holds the old path.
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const newPath = rec.slice(3);
    paths.push(newPath);
    // Check BOTH XY positions: X is the index status, Y is the working-tree
    // status. Either can carry R (rename) or C (copy), and the old-path record
    // follows the new-path record in -z porcelain regardless of which column
    // detected the rename. Missing the Y-column case (e.g. ` R`) would skip
    // the consume and let the next iteration misread the old path as a new
    // record, smuggling unallowed sources past the allow-list.
    if (/[RC]/.test(xy)) {
      const oldPath = records[i + 1];
      if (oldPath !== undefined && oldPath !== '') paths.push(oldPath);
      i++; // consume the paired old-path record
    }
  }
  return paths;
}

/**
 * Reject any staged path that is not on the push allow-list or that matches a
 * `NEVER_SYNC` entry. Builds the runtime allow-list by combining
 * `PUSH_ALLOWED_STATIC` with one `shared/projects/<logical>/` prefix per entry
 * in `path-map.json` AND, per (logical, whitelisted name) pair in
 * `map.extras ?? {}`, an exact `shared/extras/<logical>/<name>` entry plus a
 * `shared/extras/<logical>/<name>/` prefix entry (Pitfall 4 closed:
 * data-driven, no hand-rolled bypass). The exact entry permits the declared
 * name when it is a single root file (e.g. `CLAUDE.md`); the prefix entry
 * permits the declared name's subtree when it is a directory. Neither widens
 * to a logical-only prefix, so an arbitrary sibling file under the same
 * logical stays rejected. The name filter (`SUPPORTED_EXTRAS`) is the same one
 * `remapExtrasPush` honors, so manually staged content under a non-whitelisted
 * name surfaces as a FATAL instead of riding through. Logs every violation as
 * a FATAL line so the user sees the full set (not just the first), then throws
 * `NomadFatal` to unwind the caller's try/finally and release the push lock.
 */
export function enforceAllowList(statusPorcelain: string, map: PathMap): void {
  const extrasWhitelist: readonly string[] = SUPPORTED_EXTRAS;
  const allowed = [
    ...PUSH_ALLOWED_STATIC,
    ...Object.keys(map.projects).map((l) => `shared/projects/${l}/`),
    ...Object.entries(map.extras ?? {}).flatMap(([l, names]) =>
      names
        .filter((n) => extrasWhitelist.includes(n))
        .flatMap((n) => [`shared/extras/${l}/${n}`, `shared/extras/${l}/${n}/`]),
    ),
    ...(map.sharedDirs ?? []).filter((d) => isValidSharedDir(d)).map((d) => `shared/${d}/`),
  ];
  const neverSyncHits: string[] = [];
  const violations: string[] = [];
  for (const path of parsePorcelainZ(statusPorcelain)) {
    if (isNeverSync(path)) {
      neverSyncHits.push(path);
    } else if (!isAllowed(path, allowed)) {
      violations.push(path);
    }
  }
  if (neverSyncHits.length === 0 && violations.length === 0) return;
  for (const p of neverSyncHits) {
    fail(`${p} is in NEVER_SYNC and must never be pushed`);
  }
  for (const p of violations) {
    fail(`to sync ${p}, add to PUSH_ALLOWED in src/config.ts`);
  }
  throw new NomadFatal('push allow-list violations');
}
