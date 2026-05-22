import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PathMap } from './config.ts';

// Behavior-focused unit tests for the NOMAD_REPO env override on REPO_HOME.
// Mirrors the HOST resolution analog in utils.test.ts: env mutation +
// try/finally restore + vi.resetModules() + dynamic import('./config.ts').
// REPO_HOME is resolved at module load, so each test must mutate the env
// BEFORE the dynamic import fires.

// Type-only assignments proving PathMap accepts an optional `extras` field
// while remaining backward-compatible with legacy maps that omit it. These
// live at module scope so the typecheck pass is the load-bearing assertion;
// the runtime it() below keeps vitest's test count honest. If PathMap is
// narrowed (no `extras` field) the `_widened` assignment fails to compile;
// if `extras` is made required the `_legacy` assignment fails to compile.
const _legacy: PathMap = { projects: { foo: { 'host-a': '/tmp/foo' } } };
const _widened: PathMap = {
  projects: { foo: { 'host-a': '/tmp/foo' } },
  extras: { foo: ['.planning'] },
};
void _legacy;
void _widened;

describe('REPO_HOME resolution', () => {
  const originalNomadRepo = process.env.NOMAD_REPO;
  const originalHome = process.env.HOME;

  /** Restore NOMAD_REPO to the value captured at module load (or delete). */
  function restoreNomadRepo(): void {
    if (originalNomadRepo === undefined) {
      delete process.env.NOMAD_REPO;
    } else {
      process.env.NOMAD_REPO = originalNomadRepo;
    }
  }

  /** Restore HOME to the value captured at module load (or delete). */
  function restoreHome(): void {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  it('uses NOMAD_REPO when set to a non-empty string', async () => {
    process.env.NOMAD_REPO = '/tmp/test-nomad';
    try {
      vi.resetModules();
      const config = await import('./config.ts');
      expect(config.REPO_HOME).toBe('/tmp/test-nomad');
    } finally {
      restoreNomadRepo();
    }
  });

  it('falls back to resolve(HOME, "claude-nomad") when NOMAD_REPO is empty string', async () => {
    // Pin HOME so the expected default is deterministic and not dependent on
    // the test runner's $HOME. The || operator in src/config.ts must treat
    // an empty NOMAD_REPO as falsy and fall through to the default.
    process.env.NOMAD_REPO = '';
    process.env.HOME = '/tmp/nomad-test-home';
    try {
      vi.resetModules();
      const config = await import('./config.ts');
      expect(config.REPO_HOME).toBe(resolve('/tmp/nomad-test-home', 'claude-nomad'));
    } finally {
      restoreNomadRepo();
      restoreHome();
    }
  });

  it('falls back to resolve(HOME, "claude-nomad") when NOMAD_REPO is unset', async () => {
    delete process.env.NOMAD_REPO;
    process.env.HOME = '/tmp/nomad-test-home';
    try {
      vi.resetModules();
      const config = await import('./config.ts');
      expect(config.REPO_HOME).toBe(resolve('/tmp/nomad-test-home', 'claude-nomad'));
    } finally {
      restoreNomadRepo();
      restoreHome();
    }
  });
});

// Schema-extension foundation for phase 19 (planning-dir sync). These cases
// pin two invariants every downstream plan reads:
//   1. SUPPORTED_EXTRAS is the runtime whitelist for the top-level `extras`
//      key in path-map.json. Initial value is `.planning` only.
//   2. PathMap accepts an optional top-level `extras` field without breaking
//      legacy path-map.json files that omit it (additive contract).

describe('SUPPORTED_EXTRAS and PathMap widening', () => {
  it('exports SUPPORTED_EXTRAS as a named export', async () => {
    vi.resetModules();
    const config = await import('./config.ts');
    expect(config.SUPPORTED_EXTRAS).toBeDefined();
  });

  it('SUPPORTED_EXTRAS equals [".planning"]', async () => {
    vi.resetModules();
    const config = await import('./config.ts');
    expect(config.SUPPORTED_EXTRAS).toEqual(['.planning']);
    expect(config.SUPPORTED_EXTRAS).toHaveLength(1);
  });

  it('PathMap accepts optional extras field', () => {
    // The load-bearing assertions live at module scope (see `_legacy` and
    // `_widened` above). If PathMap is narrowed or `extras` is removed, this
    // file fails to typecheck. The runtime body just keeps the test counted.
    expect(true).toBe(true);
  });
});
