import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PathMap } from './config.ts';

// Behavior-focused unit tests for the NOMAD_REPO env override on REPO_HOME.
// Mirrors the HOST resolution analog in utils.test.ts: env mutation +
// try/finally restore + vi.resetModules() + dynamic import('./config.ts').
// REPO_HOME is resolved at module load, so each test must mutate the env
// BEFORE the dynamic import fires.

// Type-only assignments proving PathMap accepts optional `extras` and
// `sharedDirs` fields while remaining backward-compatible with legacy maps
// that omit them. These live at module scope so the typecheck pass is the
// load-bearing assertion; the runtime it() below keeps vitest's test count
// honest. If PathMap is narrowed (no `extras` field) the `_widened` assignment
// fails to compile; if `extras` is made required the `_legacy` assignment fails
// to compile.
const _legacy: PathMap = { projects: { foo: { 'host-a': '/tmp/foo' } } };
const _widened: PathMap = {
  projects: { foo: { 'host-a': '/tmp/foo' } },
  extras: { foo: ['.planning'] },
};
const _withSharedDirs: PathMap = {
  projects: {},
  sharedDirs: ['get-shit-done'],
};
void _legacy;
void _withSharedDirs;

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

// Schema-extension foundation for the named-extras sync. These cases pin two
// invariants every downstream consumer reads:
//   1. SUPPORTED_EXTRAS is the runtime whitelist for the top-level `extras`
//      key in path-map.json. It carries the `.planning` directory plus the
//      `CLAUDE.md` root file, proving an entry may be a directory or a file.
//   2. PathMap accepts an optional top-level `extras` field without breaking
//      legacy path-map.json files that omit it (additive contract).

describe('SUPPORTED_EXTRAS and PathMap widening', () => {
  it('exports SUPPORTED_EXTRAS as a named export', async () => {
    vi.resetModules();
    const config = await import('./config.ts');
    expect(config.SUPPORTED_EXTRAS).toBeDefined();
  });

  it('SUPPORTED_EXTRAS equals [".planning", "CLAUDE.md"]', async () => {
    vi.resetModules();
    const config = await import('./config.ts');
    expect(config.SUPPORTED_EXTRAS).toEqual(['.planning', 'CLAUDE.md']);
  });

  it('includes CLAUDE.md so a single root file is a valid extras entry', async () => {
    vi.resetModules();
    const config = await import('./config.ts');
    expect(config.SUPPORTED_EXTRAS).toContain('CLAUDE.md');
  });

  it('PathMap accepts optional extras field', () => {
    // The load-bearing assertion is the module-scope `_widened` type-test
    // above: if PathMap drops `extras` this file fails to typecheck. This
    // runtime check exercises the same value so the test asserts something real.
    expect(_widened.extras).toEqual({ foo: ['.planning'] });
  });
});

describe('SHARED_LINKS includes hooks', () => {
  it('contains "hooks" as a member of the sync set', async () => {
    vi.resetModules();
    const config = await import('./config.ts');
    expect(config.SHARED_LINKS).toContain('hooks');
  });

  it('still contains all original SHARED_LINKS members', async () => {
    vi.resetModules();
    const config = await import('./config.ts');
    for (const name of [
      'CLAUDE.md',
      'agents',
      'skills',
      'commands',
      'rules',
      'my-statusline.cjs',
    ]) {
      expect(config.SHARED_LINKS).toContain(name);
    }
  });

  it('PUSH_ALLOWED_STATIC includes "shared/hooks/"', async () => {
    vi.resetModules();
    const config = await import('./config.ts');
    expect(config.PUSH_ALLOWED_STATIC).toContain('shared/hooks/');
  });

  it('PUSH_ALLOWED_STATIC includes ".gitleaks.overlay.toml" as an exact name', async () => {
    vi.resetModules();
    const config = await import('./config.ts');
    // Exact membership (not a trailing-slash prefix entry), consistent with the
    // sibling root-level `.gitleaksignore` entry. Pins the push allow-list so the
    // user-owned overlay file can be staged by nomad push.
    expect(config.PUSH_ALLOWED_STATIC).toContain('.gitleaks.overlay.toml');
    expect(config.PUSH_ALLOWED_STATIC).not.toContain('.gitleaks.overlay.toml/');
  });

  it('PathMap accepts optional sharedDirs field', () => {
    // Load-bearing typecheck: if sharedDirs is removed from PathMap this file fails to compile.
    expect(_withSharedDirs.sharedDirs).toEqual(['get-shit-done']);
  });
});

describe('ALWAYS_NEVER_SYNC subset invariant', () => {
  it('every member of ALWAYS_NEVER_SYNC is also in NEVER_SYNC', async () => {
    vi.resetModules();
    const config = await import('./config.ts');
    for (const name of config.ALWAYS_NEVER_SYNC) {
      expect(config.NEVER_SYNC.has(name)).toBe(true);
    }
  });
});

describe('call-time resolvers: home, claudeHome, repoHome, backupBase', () => {
  const savedNomadRepo = process.env.NOMAD_REPO;
  const savedHome = process.env.HOME;

  afterEach(() => {
    if (savedNomadRepo === undefined) {
      delete process.env.NOMAD_REPO;
    } else {
      process.env.NOMAD_REPO = savedNomadRepo;
    }
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
  });

  it('home() reflects a changed HOME env between calls (no resetModules)', async () => {
    const { home } = await import('./config.ts');
    process.env.HOME = '/tmp/home-a';
    expect(home()).toBe('/tmp/home-a');
    process.env.HOME = '/tmp/home-b';
    expect(home()).toBe('/tmp/home-b');
  });

  it('claudeHome() returns resolve(home(), ".claude") and tracks HOME changes', async () => {
    const { claudeHome } = await import('./config.ts');
    process.env.HOME = '/tmp/home-c';
    expect(claudeHome()).toBe(resolve('/tmp/home-c', '.claude'));
    process.env.HOME = '/tmp/home-d';
    expect(claudeHome()).toBe(resolve('/tmp/home-d', '.claude'));
  });

  it('repoHome() returns NOMAD_REPO when set to a non-empty string', async () => {
    const { repoHome } = await import('./config.ts');
    process.env.NOMAD_REPO = '/custom/repo';
    expect(repoHome()).toBe('/custom/repo');
  });

  it('repoHome() falls through to home-based default when NOMAD_REPO is empty string', async () => {
    const { repoHome } = await import('./config.ts');
    process.env.HOME = '/tmp/home-e';
    process.env.NOMAD_REPO = '';
    expect(repoHome()).toBe(resolve('/tmp/home-e', 'claude-nomad'));
  });

  it('repoHome() falls through to home-based default when NOMAD_REPO is unset', async () => {
    const { repoHome } = await import('./config.ts');
    process.env.HOME = '/tmp/home-f';
    delete process.env.NOMAD_REPO;
    expect(repoHome()).toBe(resolve('/tmp/home-f', 'claude-nomad'));
  });

  it('repoHome() observes a mid-process NOMAD_REPO mutation without vi.resetModules', async () => {
    const { repoHome } = await import('./config.ts');
    process.env.NOMAD_REPO = '/path/a';
    expect(repoHome()).toBe('/path/a');
    process.env.NOMAD_REPO = '/path/b';
    expect(repoHome()).toBe('/path/b');
  });

  it('backupBase() returns join(home(), ".cache", "claude-nomad", "backup") and tracks HOME changes', async () => {
    const { backupBase } = await import('./config.ts');
    process.env.HOME = '/tmp/home-g';
    expect(backupBase()).toBe(join('/tmp/home-g', '.cache', 'claude-nomad', 'backup'));
    process.env.HOME = '/tmp/home-h';
    expect(backupBase()).toBe(join('/tmp/home-h', '.cache', 'claude-nomad', 'backup'));
  });
});

describe('allSharedLinks', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'error').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns SHARED_LINKS when map has no sharedDirs key', async () => {
    vi.resetModules();
    const { allSharedLinks, SHARED_LINKS } = await import('./config.ts');
    const result = allSharedLinks({ projects: {} });
    expect(result).toEqual([...SHARED_LINKS]);
  });

  it('returns SHARED_LINKS when sharedDirs is an empty array', async () => {
    vi.resetModules();
    const { allSharedLinks, SHARED_LINKS } = await import('./config.ts');
    const result = allSharedLinks({ projects: {}, sharedDirs: [] });
    expect(result).toEqual([...SHARED_LINKS]);
  });

  it('appends a valid sharedDirs entry after SHARED_LINKS', async () => {
    vi.resetModules();
    const { allSharedLinks, SHARED_LINKS } = await import('./config.ts');
    const result = allSharedLinks({ projects: {}, sharedDirs: ['get-shit-done'] });
    expect(result).toEqual([...SHARED_LINKS, 'get-shit-done']);
  });

  it('drops an invalid entry and keeps the valid one', async () => {
    vi.resetModules();
    const { allSharedLinks, SHARED_LINKS } = await import('./config.ts');
    const result = allSharedLinks({ projects: {}, sharedDirs: ['../escape', 'get-shit-done'] });
    expect(result).toEqual([...SHARED_LINKS, 'get-shit-done']);
  });

  it('emits exactly one warn for each dropped entry', async () => {
    vi.resetModules();
    const { allSharedLinks } = await import('./config.ts');
    allSharedLinks({ projects: {}, sharedDirs: ['../escape', 'get-shit-done'] });
    // console.error is called by warn(); one invalid entry -> one call
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"../escape"'));
  });

  it('drops a reserved name (hooks) with a warn', async () => {
    vi.resetModules();
    const { allSharedLinks, SHARED_LINKS } = await import('./config.ts');
    const result = allSharedLinks({ projects: {}, sharedDirs: ['hooks'] });
    expect(result).toEqual([...SHARED_LINKS]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
