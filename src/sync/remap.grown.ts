import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join, relative } from 'node:path';

const CHUNK = 64 * 1024;

/**
 * True when the local file is strictly longer than the repo file and begins with
 * the repo file's bytes. Only the repo-length prefix is read, in fixed chunks;
 * files that are not strictly larger are never opened.
 */
function isGrownLocally(repoFile: string, repoSize: number, localFile: string): boolean {
  const local = lstatSync(localFile, { throwIfNoEntry: false });
  if (!local?.isFile() || local.size <= repoSize) return false;
  const repoBuf = Buffer.allocUnsafe(CHUNK);
  const localBuf = Buffer.allocUnsafe(CHUNK);
  const repoFd = openSync(repoFile, 'r');
  try {
    const localFd = openSync(localFile, 'r');
    try {
      let pos = 0;
      for (;;) {
        const n = readSync(repoFd, repoBuf, 0, CHUNK, pos);
        if (n === 0) return true;
        const m = readSync(localFd, localBuf, 0, n, pos);
        if (!repoBuf.subarray(0, n).equals(localBuf.subarray(0, m))) return false;
        pos += n;
      }
    } finally {
      closeSync(localFd);
    }
  } finally {
    closeSync(repoFd);
  }
}

/** Recursive walk behind `listGrownLocally`; both dirs must be real directories to descend. */
function walk(srcRoot: string, srcDir: string, dstDir: string, out: Set<string>): void {
  if (!lstatSync(dstDir, { throwIfNoEntry: false })?.isDirectory()) return;
  for (const name of readdirSync(srcDir)) {
    const srcPath = join(srcDir, name);
    const st = lstatSync(srcPath);
    if (st.isDirectory()) {
      walk(srcRoot, srcPath, join(dstDir, name), out);
    } else if (
      name.endsWith('.jsonl') &&
      st.isFile() &&
      isGrownLocally(srcPath, st.size, join(dstDir, name))
    ) {
      out.add(relative(srcRoot, srcPath));
    }
  }
}

/**
 * Src-relative paths of repo `.jsonl` files whose local copy grew since the last
 * push (local strictly longer and byte-prefixed by the repo copy). Repo symlinks
 * are never followed.
 */
export function listGrownLocally(src: string, dst: string): Set<string> {
  const out = new Set<string>();
  walk(src, src, dst, out);
  return out;
}
