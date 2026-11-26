/**
 * Staging helpers for the gitleaks scans: `git add` the tree `scanStagedTree`
 * scans, and the private scratch repo `scanFile` stages one file into, each with
 * git set up so outside config cannot hide content from gitleaks.
 */

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { claudeHome } from '../../core/config.ts';

/**
 * Scan exec options for a repo dir. An inherited GIT_DIR/GIT_INDEX_FILE/
 * GIT_WORK_TREE (e.g. from a git hook) would stage into the caller's repo
 * instead of `repoDir`, so they are stripped.
 */
export function repoExecOpts(repoDir: string): ExecFileSyncOptions {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  return { cwd: repoDir, env, stdio: ['ignore', 'pipe', 'pipe'] };
}

/** Local attributes line that makes git show every file to gitleaks as text. */
const FORCE_DIFF = '* diff';

/**
 * Write `body` to `path` through a sibling temp file and rename, so a read-only
 * file in a writable dir still takes it; `mode` keeps the original permissions.
 */
function replaceFile(path: string, body: string, mode?: number): void {
  const tmp = `${path}.nomad-${process.pid}`;
  writeFileSync(tmp, body, mode === undefined ? undefined : { mode });
  renameSync(tmp, path);
}

/**
 * Append `* diff` to the repo's local `info/attributes` and return a function
 * that puts the file back. A global or committed `-diff`/`binary` would make
 * `git diff` hide the content, so gitleaks would scan nothing; the last
 * matching line wins, and `diff` changes only diff output, never what is staged.
 */
export function forceTextDiff(opts: ExecFileSyncOptions): () => void {
  const rel = String(execFileSync('git', ['rev-parse', '--git-path', 'info/attributes'], opts));
  const path = resolve(String(opts.cwd), rel.trim() || join('.git', 'info', 'attributes'));
  let body: string | null = null;
  let mode: number | undefined;
  try {
    body = readFileSync(path, 'utf8');
    mode = statSync(path).mode & 0o777;
  } catch {
    // Absent: written fresh below and removed on restore.
  }
  mkdirSync(dirname(path), { recursive: true });
  const prior = body ?? '';
  const glue = prior === '' || prior.endsWith('\n') ? '' : '\n';
  replaceFile(path, `${prior}${glue}${FORCE_DIFF}\n`, mode);
  return () => (body === null ? rmSync(path, { force: true }) : replaceFile(path, body, mode));
}

/**
 * `git add -A` in the repo `opts` point at. Drops stdout and raises the stderr
 * buffer: a per-file CRLF warning (Git for Windows default) across thousands
 * of files would overflow the 1 MB default.
 */
export function stageAll(opts: ExecFileSyncOptions): void {
  execFileSync('git', ['add', '-A'], {
    ...opts,
    stdio: ['ignore', 'ignore', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Fallback repo-relative staging path for a local file, used when the caller
 * does not pass the real one. The projects segment stays the encoded dir (push
 * uses the logical name), which the bundled `[^/]+` path patterns still match.
 * Files outside projects/ and skills/ get a fixed neutral name, so a source
 * named like `.gitattributes` is never interpreted by git or gitleaks.
 */
export function stagedRelPath(filePath: string): string {
  const abs = resolve(filePath);
  for (const dir of ['projects', 'skills']) {
    const root = join(claudeHome(), dir) + sep;
    if (abs.startsWith(root)) return join('shared', dir, abs.slice(root.length));
  }
  return join('scan', 'file.txt');
}

/** Config overrides for the scratch repo: no CRLF rewrite, no fsmonitor daemon, no hooks. */
const SCRATCH_GIT_CONFIG = [
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=.nomad-no-hooks',
];

/**
 * Exec options for the scratch repo. Every inherited `GIT_*` var is dropped: an
 * object-dir or alternates override would write the unredacted blob outside
 * the private scratch dir.
 */
export function scratchExecOpts(repoDir: string): ExecFileSyncOptions {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')),
  );
  return { cwd: repoDir, env, stdio: ['ignore', 'pipe', 'pipe'] };
}

/** `opts` with the time left until `deadline` (epoch ms) as its timeout, at least 1 ms. */
export function until(opts: ExecFileSyncOptions, deadline: number): ExecFileSyncOptions {
  return { ...opts, timeout: Math.max(1, deadline - Date.now()) };
}

/**
 * Init the scratch repo and stage its one file byte-for-byte. Repo-level
 * attributes override any global `core.attributesFile` (EOL, LFS filter, ident,
 * encoding), `-f` beats a global exclude, and the final `ls-files` throws when
 * git staged nothing (a `.git` path segment, say), so a skipped file fails
 * closed instead of scanning clean.
 */
export function stageScratchCopy(opts: ExecFileSyncOptions, rel: string, deadline: number): void {
  execFileSync('git', ['init', '-q'], until(opts, deadline));
  const info = join(String(opts.cwd), '.git', 'info');
  mkdirSync(info, { recursive: true });
  // `diff` beats an inherited `-diff`/`binary`, which would hide the content from gitleaks.
  writeFileSync(join(info, 'attributes'), '* -text -filter -ident -working-tree-encoding diff\n');
  execFileSync('git', [...SCRATCH_GIT_CONFIG, 'add', '-f', '-A'], {
    ...until(opts, deadline),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const pathspec = rel.split(sep).join('/');
  const ls = [...SCRATCH_GIT_CONFIG, '--literal-pathspecs', 'ls-files', '--error-unmatch'];
  execFileSync('git', [...ls, '--', pathspec], until(opts, deadline));
}

/**
 * Remove the scratch dir, retrying a transient Windows `EBUSY`, and warn rather
 * than throw if it stays: the dir is owner-only, and the scan result still stands.
 */
export function removeScratch(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    process.stderr.write(`nomad: could not remove scan scratch dir ${dir}; delete it by hand.\n`);
  }
}
