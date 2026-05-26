import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
