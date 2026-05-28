import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type * as fsModule from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { failGlyph, infoGlyph, warnGlyph } from './color.ts';
import { section } from './commands.doctor.format.ts';
import {
  type Env,
  joinedLog,
  makeDoctorEnv,
  restoreEnv,
} from './commands.doctor.checks.test-helpers.ts';

describe('cmdDoctor NOMAD_REPO annotation', () => {
  // The annotation lives in reportRepoState (per SPEC §5). It must appear on
  // all three branches (populated/partial/empty) when NOMAD_REPO is set, and
  // be absent when the env is unset. NO_COLOR=1 is critical: ANSI escapes
  // would split the literal `(NOMAD_REPO)` substring from surrounding text.
  // The env mutation MUST happen before makeDoctorEnv (which calls
  // vi.resetModules) so config.ts re-reads NOMAD_REPO on its next module load.
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let originalNomadRepo: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    originalNomadRepo = process.env.NOMAD_REPO;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    restoreEnv('NOMAD_REPO', originalNomadRepo);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('appends ` (NOMAD_REPO)` to the repo-state line when NOMAD_REPO is set', async () => {
    // Set NOMAD_REPO to the sandbox's claude-nomad dir BEFORE makeDoctorEnv
    // so the override resolves to a populated scaffold (not a stray path).
    // makeDoctorEnv writes settings.base.json by default; classifyRepoState
    // will see at least a partial scaffold and the annotation must appear.
    const fakeHome = mkdtempSync(join(tmpdir(), 'nomad-test-home-'));
    process.env.NOMAD_REPO = join(fakeHome, 'claude-nomad');
    rmSync(fakeHome, { recursive: true, force: true });
    env = makeDoctorEnv({ host: 'test-host' });
    process.env.NOMAD_REPO = join(env.testHome, 'claude-nomad');
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('repo state:');
    expect(out).toContain(' (NOMAD_REPO)');
  });

  it('omits the (NOMAD_REPO) annotation when the env var is unset', async () => {
    delete process.env.NOMAD_REPO;
    env = makeDoctorEnv({ host: 'test-host' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('repo state:');
    expect(out).not.toContain('(NOMAD_REPO)');
  });
});

describe('reportSharedLinks TOCTOU safety', () => {
  // Regression tests for the try/catch wrapping lstatSync in reportSharedLinks.
  // A SHARED_LINKS path that throws ENOENT must emit the existing warn row and
  // leave exitCode at 0. A non-ENOENT error (e.g. EACCES) must emit a fail row,
  // set exitCode = 1, and never throw. Both cases must not interrupt the loop.
  //
  // Pattern: vi.doMock('node:fs') to inject a throwing lstatSync for the target
  // path only, then dynamically import the SUT so module isolation is clean.
  // vi.doUnmock + vi.resetModules in afterEach prevent leaks across tests.

  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    originalNomadRepo = process.env.NOMAD_REPO;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;

    // Create a minimal sandbox HOME so config.ts resolves CLAUDE_HOME to a
    // known path. We do not need the full makeDoctorEnv harness here because
    // we drive reportSharedLinks directly rather than going through cmdDoctor.
    testHome = mkdtempSync(join(tmpdir(), 'nomad-lstat-test-'));
    process.env.HOME = testHome;
    // Point NOMAD_REPO away from any real repo so config.ts does not accidentally
    // read state from the developer's machine.
    process.env.NOMAD_REPO = join(testHome, 'claude-nomad');
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    vi.doUnmock('node:fs');
    vi.resetModules();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    restoreEnv('NOMAD_REPO', originalNomadRepo);
    rmSync(testHome, { recursive: true, force: true });
  });

  /**
   * Build a coded NodeJS.ErrnoException for failure-injection tests.
   *
   * @param code The errno code string (e.g. 'ENOENT', 'EACCES').
   * @param message Human-readable message (default matches the code).
   * @returns A typed error the mock lstatSync can throw.
   */
  function makeErrnoError(code: string, message?: string): NodeJS.ErrnoException {
    const err = new Error(message ?? code) as NodeJS.ErrnoException;
    err.code = code;
    return err;
  }

  it('emits an info "not synced" row and leaves exitCode=0 when lstatSync throws ENOENT and the repo has no source', async () => {
    // Inject a lstatSync that throws ENOENT only for paths under CLAUDE_HOME
    // (any SHARED_LINKS entry); all other lstat calls pass through so the
    // module itself can load without side-effects. The sandbox repo has no
    // shared/<name> sources, so an absent link is expected (nothing to sync).
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        lstatSync: vi.fn((p: fsModule.PathLike, opts?: unknown) => {
          if (typeof p === 'string' && p.includes('.claude')) {
            throw makeErrnoError('ENOENT');
          }
          // @ts-expect-error -- pass-through with optional opts param
          return actual.lstatSync(p, opts);
        }),
      };
    });
    vi.resetModules();
    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    // Every SHARED_LINKS entry threw ENOENT with no repo source -> info rows.
    expect(sec.items.length).toBeGreaterThan(0);
    for (const item of sec.items) {
      expect(item).toContain(infoGlyph);
      expect(item).toContain('not synced');
    }
    expect(process.exitCode).toBe(0);
  });

  it('warns "missing" with a pull hint when lstatSync throws ENOENT but the repo still has the shared source', async () => {
    // Same ENOENT injection, but this time every link has a live shared/<name>
    // source in the repo, so an absent link is a real out-of-sync state.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        lstatSync: vi.fn((p: fsModule.PathLike, opts?: unknown) => {
          if (typeof p === 'string' && p.includes('.claude')) {
            throw makeErrnoError('ENOENT');
          }
          // @ts-expect-error -- pass-through with optional opts param
          return actual.lstatSync(p, opts);
        }),
      };
    });
    vi.resetModules();
    const { SHARED_LINKS } = await import('./config.ts');
    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    for (const name of SHARED_LINKS) {
      mkdirSync(join(testHome, 'claude-nomad', 'shared', name), { recursive: true });
    }
    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    expect(sec.items.length).toBeGreaterThan(0);
    for (const item of sec.items) {
      expect(item).toContain(warnGlyph);
      expect(item).toContain('missing');
      expect(item).toContain('nomad pull');
    }
    expect(process.exitCode).toBe(0);
  });

  it('emits a fail row and sets exitCode=1 when lstatSync throws EACCES, without throwing', async () => {
    // Inject a lstatSync that throws EACCES for CLAUDE_HOME paths to simulate
    // a permission-denied scenario. The reporter must NOT rethrow; it must emit
    // a failGlyph row and set process.exitCode = 1.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        lstatSync: vi.fn((p: fsModule.PathLike, opts?: unknown) => {
          if (typeof p === 'string' && p.includes('.claude')) {
            throw makeErrnoError('EACCES', 'permission denied');
          }
          // @ts-expect-error -- pass-through with optional opts param
          return actual.lstatSync(p, opts);
        }),
      };
    });
    vi.resetModules();
    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const sec = section('Links');

    expect(() => reportSharedLinks(sec, { projects: {} })).not.toThrow();

    expect(sec.items.length).toBeGreaterThan(0);
    for (const item of sec.items) {
      expect(item).toContain(failGlyph);
      expect(item).toContain('EACCES');
    }
    expect(process.exitCode).toBe(1);
  });

  it('continues the loop after a throwing entry and reports all SHARED_LINKS', async () => {
    // Throw EACCES only for the first SHARED_LINKS path; subsequent entries
    // should still be reported (loop continuation). Use a call-count gate so
    // call 1 throws and subsequent calls pass through to the real lstatSync.
    // The real paths will not exist in the sandbox so they throw ENOENT, which
    // is the warn branch -- still confirms the loop ran for all entries.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      let callCount = 0;
      return {
        ...actual,
        lstatSync: vi.fn((p: fsModule.PathLike, opts?: unknown) => {
          if (typeof p === 'string' && p.includes('.claude')) {
            callCount++;
            if (callCount === 1) throw makeErrnoError('EACCES', 'permission denied');
            throw makeErrnoError('ENOENT');
          }
          // @ts-expect-error -- pass-through with optional opts param
          return actual.lstatSync(p, opts);
        }),
      };
    });
    vi.resetModules();
    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const { SHARED_LINKS } = await import('./config.ts');
    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    // All SHARED_LINKS entries should have produced a row.
    expect(sec.items).toHaveLength(SHARED_LINKS.length);
    // First item is EACCES (fail row).
    expect(sec.items[0]).toContain(failGlyph);
    // Remaining items are ENOENT with no repo source (info "not synced" rows).
    for (const item of sec.items.slice(1)) {
      expect(item).toContain(infoGlyph);
      expect(item).toContain('not synced');
    }
  });
});
