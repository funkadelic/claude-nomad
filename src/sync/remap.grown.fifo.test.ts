import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const MODULE = pathToFileURL(resolve('src/sync/remap.grown.ts')).href;

describe('listGrownLocally with a FIFO', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  // A subprocess with a timeout, so a blocking open fails the test instead of hanging the suite.
  it.skipIf(process.platform === 'win32')('does not block on a local FIFO with no writer', () => {
    root = mkdtempSync(join(tmpdir(), 'nomad-fifo-'));
    const src = join(root, 'src');
    const dst = join(root, 'dst');
    mkdirSync(src);
    mkdirSync(dst);
    writeFileSync(join(src, 'a.jsonl'), 'A');
    execFileSync('mkfifo', [join(dst, 'a.jsonl')]);
    const script = `import(${JSON.stringify(MODULE)}).then((m) => { process.stdout.write(String(m.listGrownLocally(${JSON.stringify(src)}, ${JSON.stringify(dst)}).size)); })`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10_000 });
    expect(r.signal).toBeNull();
    expect(r.stdout).toBe('0');
  });
});
