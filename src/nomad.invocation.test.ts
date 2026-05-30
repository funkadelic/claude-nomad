import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Shim-invocation guard for the bin entrypoint under the `#!/usr/bin/env node`
// shebang. Spawns the real `node src/nomad.ts --version` (not an in-process
// import) so the assertion exercises the same path the installed `nomad`
// binary takes: Node native type-stripping runs the .ts source directly.
// This pins the byte-stable --version contract the npm-publish smoke test
// strict-equals, and proves no ExperimentalWarning leaks to stderr at the
// >=22.22.1 engine floor.

/**
 * Absolute path to the bin entrypoint, resolved relative to this test file so
 * the spawn works regardless of the process cwd.
 *
 * @returns The filesystem path to `src/nomad.ts`.
 */
const nomadEntrypoint = (): string => fileURLToPath(new URL('./nomad.ts', import.meta.url));

describe('nomad bin invocation', () => {
  it('runs `node src/nomad.ts --version` with exit 0, bare semver, empty stderr', () => {
    const result = spawnSync(process.execPath, [nomadEntrypoint(), '--version'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.stderr).toBe('');
  });
});
