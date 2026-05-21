import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// Behavior-focused unit tests for the NOMAD_REPO env override on REPO_HOME.
// Mirrors the HOST resolution analog in utils.test.ts: env mutation +
// try/finally restore + vi.resetModules() + dynamic import('./config.ts').
// REPO_HOME is resolved at module load, so each test must mutate the env
// BEFORE the dynamic import fires.

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
