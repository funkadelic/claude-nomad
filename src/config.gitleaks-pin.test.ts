import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GITLEAKS_PINNED_VERSION } from './config.ts';

// Drift-gate (D-05): a pure file-read comparison asserting GITLEAKS_PINNED_VERSION
// stays in lockstep with the GITLEAKS_VERSION env pinned in both CI workflow
// YAMLs. No mocks, no module-resetting, no YAML parser (none is in the tree).
// A bump that touches the workflows but misses the constant (or vice versa)
// fails here before it can ship "works in CI, fails locally" gitleaks drift.

/** Anchored matcher for a `GITLEAKS_VERSION:` line in a workflow YAML. Any
 * leading indentation is tolerated; the bare value is captured. */
const PIN_LINE = /^\s*GITLEAKS_VERSION:\s*(\S+)\s*$/m;

/**
 * Read a workflow YAML under `.github/workflows/` (resolved relative to this
 * source module, one directory up) and extract its `GITLEAKS_VERSION` pin.
 *
 * Uses a dependency-free anchored regex against the raw file text rather than a
 * YAML parser, since none is in the dependency tree. The pattern matches a
 * `GITLEAKS_VERSION:` key (any leading indentation) and captures the bare value
 * on the rest of the line.
 *
 * @param rel - Workflow filename relative to `.github/workflows/`
 *   (e.g. `tests.yml`).
 * @returns The captured pin string (e.g. `8.30.1`).
 * @throws If the file has no `GITLEAKS_VERSION:` line.
 */
function readWorkflowPin(rel: string): string {
  const path = fileURLToPath(new URL(`../.github/workflows/${rel}`, import.meta.url));
  const raw = readFileSync(path, 'utf8');
  const m = PIN_LINE.exec(raw);
  if (m === null) {
    throw new Error(`no GITLEAKS_VERSION pin found in .github/workflows/${rel}`);
  }
  return m[1];
}

describe('gitleaks pin drift-gate', () => {
  it('GITLEAKS_PINNED_VERSION equals the GITLEAKS_VERSION pin in tests.yml', () => {
    expect(readWorkflowPin('tests.yml')).toBe(GITLEAKS_PINNED_VERSION);
  });

  it('GITLEAKS_PINNED_VERSION equals the GITLEAKS_VERSION pin in gitleaks.yml', () => {
    expect(readWorkflowPin('gitleaks.yml')).toBe(GITLEAKS_PINNED_VERSION);
  });
});
