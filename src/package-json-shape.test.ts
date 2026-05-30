import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Regression guard for the npm publish-required fields. Reads the real
// repo-root package.json (NOT a sandbox copy) and asserts the declarative
// shape that SPEC §1 / §3 / §8 require. A future PR that drops a publish
// field, reintroduces tsx as a dependency, or breaks the prepublishOnly
// chain will fail this test locally before `prepublishOnly` would catch it
// in CI.

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;

describe('package.json shape', () => {
  it('declares every npm publish-required field', () => {
    // SPEC §1: bin, description, keywords, repository, homepage, bugs, files,
    // license must all be present and truthy on the published package.json.
    const required = [
      'bin',
      'description',
      'keywords',
      'repository',
      'homepage',
      'bugs',
      'files',
      'license',
    ] as const;
    const missing = required.filter((key) => !pkg[key]);
    expect(missing).toEqual([]);
  });

  it('declares bin.nomad pointing at ./src/nomad.ts', () => {
    // SPEC §2: the `nomad` bin resolves to the existing TS entrypoint; the
    // `#!/usr/bin/env node` shebang runs it directly under Node native
    // type-stripping (no tsx, no compile step).
    const bin = pkg.bin as Record<string, unknown> | undefined;
    expect(bin?.nomad).toBe('./src/nomad.ts');
  });

  it('does NOT ship tsx in dependencies or devDependencies', () => {
    // SPEC §3: tsx was removed entirely. The bin shim now runs src/nomad.ts
    // under Node native type-stripping (stable/default-on at the >=22.22.1
    // engine floor), so no runtime transpiler dependency is needed. Reintroducing
    // tsx would revive the npx-shebang first-run network fetch this change removed.
    const dependencies = pkg.dependencies as Record<string, unknown> | undefined;
    const devDependencies = pkg.devDependencies as Record<string, unknown> | undefined;
    expect(dependencies?.tsx).toBeUndefined();
    expect(devDependencies?.tsx).toBeUndefined();
  });

  it('declares a prepublishOnly script that chains lint, typecheck, and test', () => {
    // SPEC §8: prepublishOnly is the gate that fires on `npm publish`.
    // Substring assertions (not exact-match) so the planner can choose the
    // exact chain (e.g. additional verify-tarball.cjs hop after the trio).
    const scripts = pkg.scripts as Record<string, unknown> | undefined;
    const prepublishOnly = scripts?.prepublishOnly;
    expect(typeof prepublishOnly).toBe('string');
    expect(prepublishOnly as string).toContain('lint');
    expect(prepublishOnly as string).toContain('typecheck');
    expect(prepublishOnly as string).toContain('test');
  });
});
