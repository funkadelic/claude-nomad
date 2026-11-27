/**
 * Re-scans the real content behind staged files the index holds only as a
 * transform of the working tree (a clean filter such as git-lfs, or a
 * `working-tree-encoding`), which the staged scan never sees.
 */

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { join } from 'node:path';

import { GITLEAKS_SCAN_TIMEOUT_MS } from '../../core/config.ts';
import type { Finding, ScanFn } from './gitleaks.scan.ts';
import { repoExecOpts } from './gitleaks.stage.ts';

/** Index modes git runs filters on; symlinks and gitlinks are never filtered. */
const REGULAR_MODES = new Set(['100644', '100755']);

/** Attribute values that leave a path untransformed. */
const INACTIVE = new Set(['unspecified', 'unset']);

/** stdin must be a pipe: execFileSync drops `input` when stdio[0] is 'ignore'. */
const PIPED: ExecFileSyncOptions['stdio'] = ['pipe', 'pipe', 'pipe'];

/** Split `buf` on NUL bytes, dropping the final terminator. */
function splitNul(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = buf.indexOf(0); i !== -1; i = buf.indexOf(0, start)) {
    out.push(buf.subarray(start, i));
    start = i + 1;
  }
  return out;
}

/** The tree the index is diffed against: HEAD, or the empty tree on an unborn branch. */
function baseTree(opts: ExecFileSyncOptions): string {
  try {
    return String(execFileSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], opts)).trim();
  } catch {
    const empty = execFileSync('git', ['hash-object', '-t', 'tree', '--stdin'], {
      ...opts,
      stdio: PIPED,
      input: '',
    });
    return String(empty).trim();
  }
}

/**
 * Raw path bytes of the regular files the index changes against the base tree,
 * deletions excluded. Plumbing `diff-index` ignores `diff.*` porcelain config
 * such as `diff.orderFile`, so a bad setting there cannot fail the listing.
 */
function changedRegularFiles(opts: ExecFileSyncOptions): Buffer[] {
  const args = ['diff-index', '--cached', '--no-renames', '--diff-filter=d', '-z', baseTree(opts)];
  // Records are `:srcmode dstmode srcsha dstsha status` NUL `path` NUL.
  const parts = splitNul(execFileSync('git', args, opts) as Buffer);
  const paths: Buffer[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (REGULAR_MODES.has(parts[i].toString('latin1').split(' ')[1])) paths.push(parts[i + 1]);
  }
  return paths;
}

/** `raw` as a string, throwing when it is not valid UTF-8 (fs would name another file). */
function utf8Path(raw: Buffer): string {
  const path = raw.toString('utf8');
  if (!Buffer.from(path, 'utf8').equals(raw)) {
    throw new Error(`cannot re-scan ${path}: the path is not valid UTF-8`);
  }
  return path;
}

/**
 * Changed regular files whose `filter` or `working-tree-encoding` attribute is
 * active. Throws on any git failure so the caller can fail closed.
 */
function filteredPaths(repoDir: string): string[] {
  const opts = { ...repoExecOpts(repoDir), maxBuffer: 64 * 1024 * 1024 };
  const changed = changedRegularFiles(opts);
  if (changed.length === 0) return [];
  const attrs = execFileSync(
    'git',
    ['check-attr', '--stdin', '-z', 'filter', 'working-tree-encoding'],
    { ...opts, stdio: PIPED, input: Buffer.concat(changed.flatMap((p) => [p, Buffer.from([0])])) },
  ) as Buffer;
  // Output is `path NUL attr NUL value NUL`, once per path and attribute.
  const parts = splitNul(attrs);
  const paths = new Set<string>();
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (!INACTIVE.has(parts[i + 2].toString('utf8'))) paths.add(utf8Path(parts[i]));
  }
  return [...paths];
}

/**
 * Dedupe key: gitleaks fingerprints carry no column, so two secrets on one line
 * share one; an empty fingerprint falls back to file, rule and line.
 */
const findingKey = (f: Finding): string => {
  const fp = f.Fingerprint === '' ? `${f.File}:${f.RuleID}:${f.StartLine}` : f.Fingerprint;
  return `${fp}:${f.StartColumn}:${f.EndColumn}`;
};

/**
 * Re-scan each changed regular file whose index content is a transform of its
 * working-tree file via `scan` (which stages with every transform off) and
 * merge the results into `staged`, dropping only findings the staged scan
 * already reported at the same position. All re-scans share one scan timeout.
 * Returns `null` when the listing or any per-file scan fails or the time runs
 * out, so the push gate fails closed.
 */
export function withFilteredFindings(
  repoDir: string,
  staged: Finding[],
  scan: ScanFn,
  forwardStreams: boolean,
): Finding[] | null {
  const abort = (why: string): null => {
    if (forwardStreams) process.stderr.write(`scan aborted: ${why}\n`);
    return null;
  };
  let paths: string[];
  try {
    paths = filteredPaths(repoDir);
  } catch (err) {
    return abort(String((err as Error).message).split('\n')[0]);
  }
  const deadline = Date.now() + GITLEAKS_SCAN_TIMEOUT_MS;
  const stagedKeys = new Set(staged.map(findingKey));
  const merged = [...staged];
  for (const rel of paths) {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) return abort(`timed out before re-scanning ${rel}`);
    let found: Finding[] | null;
    try {
      found = scan(join(repoDir, rel), {
        timeoutMs,
        stagedRel: rel,
        redact: true,
        repoDir,
        forwardStreams,
      });
    } catch (err) {
      return abort(`could not re-scan ${rel}: ${String((err as Error).message).split('\n')[0]}`);
    }
    if (found === null) return abort(`could not re-scan ${rel}`);
    merged.push(...found.filter((f) => !stagedKeys.has(findingKey(f))));
  }
  return merged;
}
