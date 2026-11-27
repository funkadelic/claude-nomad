import { execFileSync } from 'node:child_process';

import { MAX_SESSION_FILE_BYTES } from '../../core/config.ts';
import { EXIT } from '../../core/exit-codes.ts';
import { gitCaptureRaw, NomadFatal } from '../../core/utils.ts';
import { mib } from '../../sync/remap.size.ts';

/** Run git in `repo` with `input` on stdin and return stdout. */
const gitWithInput = (repo: string, args: string[], input: string): string =>
  execFileSync('git', args, {
    cwd: repo,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).toString();

/** `HEAD`, or the empty tree when HEAD is unborn. */
function diffBase(repo: string): string {
  try {
    gitCaptureRaw(['rev-parse', '--verify', '--quiet', 'HEAD'], repo);
    return 'HEAD';
  } catch {
    return gitWithInput(repo, ['hash-object', '-t', 'tree', '--stdin'], '').trim();
  }
}

/** Every added or modified staged blob as `{ path, size }`; gitlinks are left out. */
function stagedSizes(repo: string): { path: string; size: number }[] {
  const fields = gitCaptureRaw(
    ['diff-index', '--cached', '-z', '--no-renames', '--diff-filter=d', diffBase(repo)],
    repo,
  ).split('\0');
  const blobs: { path: string; id: string }[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, mode, , id] = fields[i].split(' ');
    if (mode !== '160000') blobs.push({ path: fields[i + 1], id });
  }
  const lines = gitWithInput(
    repo,
    ['cat-file', '--batch-check=%(objectname) %(objectsize)'],
    blobs.map((b) => `${b.id}\n`).join(''),
  ).split('\n');
  return blobs.map((b, i) => {
    const m = /^\S+ (\d+)$/.exec(lines[i]);
    if (m === null) throw new Error(`unexpected cat-file output for ${b.path}`);
    return { path: b.path, size: Number(m[1]) };
  });
}

/**
 * Refuse to commit when any staged file is over `cap` bytes (GitHub rejects the
 * whole push), or if sizes cannot be read. The index is left as is.
 * @param repo - Sync repo root.
 * @param cap - Per-file byte limit; overridable for tests.
 */
export function assertStagedUnderCap(repo: string, cap = MAX_SESSION_FILE_BYTES): void {
  let sizes: { path: string; size: number }[];
  try {
    sizes = stagedSizes(repo);
  } catch (err) {
    throw new NomadFatal(
      `could not check staged file sizes, so nothing was committed: ${String(err)}`,
      { code: EXIT.GENERIC_FAILURE },
    );
  }
  const over = sizes.filter((s) => s.size > cap);
  if (over.length === 0) return;
  const list = over.map((s) => `  ${s.path} (${mib(s.size)} MiB)`).join('\n');
  // Push re-copies shared/extras/ from each project, so a repo-side edit would not stick.
  const extras = over.some((s) => s.path.startsWith('shared/extras/'))
    ? 'A file under shared/extras/ is copied from your project on every push: change it there. '
    : '';
  throw new NomadFatal(
    `GitHub rejects files over ${mib(cap)} MiB, so nothing was committed. Too big:\n${list}\n` +
      extras +
      `Remove or shrink each other file in ${repo}, or run \`nomad drop-session <id>\` for a ` +
      'session, then run `nomad push` again.',
    { code: EXIT.GENERIC_FAILURE },
  );
}
