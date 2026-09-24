import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { expandStagedDir } from './git.ts';

describe('expandStagedDir', () => {
  it('returns an empty list when git ls-files cannot run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nomad-expand-'));
    try {
      // A cwd that does not exist makes the spawn itself fail.
      expect(expandStagedDir('shared/projects/p/sid', join(dir, 'missing'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
