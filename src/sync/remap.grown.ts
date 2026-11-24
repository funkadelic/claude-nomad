import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { join, relative } from 'node:path';

const CHUNK = 64 * 1024;

/**
 * Open `path` for reading and return its fd only when it is a regular file, not a
 * symlink, larger than `minSize`. Checks run on the open fd so the file cannot be
 * swapped between check and read; the caller closes the fd.
 */
function openLargerRegular(path: string, minSize: number): number | null {
  let fd: number;
  try {
    // O_NONBLOCK so a FIFO with no writer cannot hang pull; undefined (no-op) on Windows.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  const st = fstatSync(fd);
  const link = lstatSync(path, { throwIfNoEntry: false });
  if (st.isFile() && st.size > minSize && link?.ino === st.ino && !link.isSymbolicLink()) {
    return fd;
  }
  closeSync(fd);
  return null;
}

/**
 * True when the local file is strictly longer than the repo file and begins with
 * the repo file's bytes. Only the repo-length prefix is read, in fixed chunks.
 */
function isGrownLocally(repoFile: string, repoSize: number, localFile: string): boolean {
  const localFd = openLargerRegular(localFile, repoSize);
  if (localFd === null) return false;
  const repoBuf = Buffer.allocUnsafe(CHUNK);
  const localBuf = Buffer.allocUnsafe(CHUNK);
  try {
    const repoFd = openSync(repoFile, 'r');
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
      closeSync(repoFd);
    }
  } finally {
    closeSync(localFd);
  }
}

/** Recursive walk behind `listGrownLocally`; both dirs must be real directories to descend. */
function walk(srcRoot: string, srcDir: string, dstDir: string, out: Set<string>): void {
  if (
    !lstatSync(srcDir, { throwIfNoEntry: false })?.isDirectory() ||
    !lstatSync(dstDir, { throwIfNoEntry: false })?.isDirectory()
  ) {
    return;
  }
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
