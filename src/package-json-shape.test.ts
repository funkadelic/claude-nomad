import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Regression guard for the npm publish-required fields. Reads the real
// repo-root package.json (NOT a sandbox copy) and asserts the declarative
// shape that SPEC §1 / §3 / §8 require. A future PR that drops a publish
// field, removes tsx from dependencies, or breaks the prepublishOnly chain
// will fail this test locally before `prepublishOnly` would catch it in CI.

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
    // SPEC §2: the `nomad` bin resolves to the existing TS entrypoint; tsx
    // (a runtime dep, see next test) handles the shebang transpile.
    const bin = pkg.bin as Record<string, unknown> | undefined;
    expect(bin?.nomad).toBe('./src/nomad.ts');
  });

  it('ships tsx in dependencies, not devDependencies', () => {
    // SPEC §3: tsx must be a runtime dep so the shebang on src/nomad.ts
    // resolves after `npm i -g claude-nomad`. Caret range preserved upstream.
    const dependencies = pkg.dependencies as Record<string, unknown> | undefined;
    const devDependencies = pkg.devDependencies as Record<string, unknown> | undefined;
    expect(dependencies?.tsx).toBeTruthy();
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
