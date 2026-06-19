import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildPushRepo,
  g,
  gitOut,
  plantLocalSession,
  setTestIdentity,
} from './test-support/git.ts';

/**
 * Full-pipeline cmdPush acceptance against a real bare-origin + clone pair and
 * the real gitleaks binary. The rest of the push suite verifies each stage in
 * isolation with a mocked child_process; this file drives the whole documented
 * ordering (rebase -> remap -> add -> scan -> commit -> push) end to end so a
 * reordering regression in the safety pipeline (e.g. committing before the scan,
 * or pushing without rebasing) is caught. Gated on the real binary so local dev
 * without gitleaks still runs the rest of the suite.
 */
const hasGitleaks = ((): boolean => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGitleaks)('cmdPush end-to-end (real git + real gitleaks)', () => {
  let tmp: string;
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNomadHost = process.env.NOMAD_HOST;
    tmp = mkdtempSync(join(tmpdir(), 'nomad-cmdpush-e2e-'));
    // Known baseline so the success-path assertion can require exitCode stayed 0
    // rather than merely "not 1" (cmdPush leaves exitCode untouched on success).
    process.exitCode = 0;
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('pushes a clean session end-to-end, rebasing onto a diverged upstream first', async () => {
    const { local, origin, projectRoot } = buildPushRepo(tmp);
    process.env.HOME = tmp;
    process.env.NOMAD_REPO = local;

    // Diverge upstream: a second clone pushes a commit the local repo lacks. A
    // push that lands on top of this proves the rebase ran before the push.
    const other = join(tmp, 'other');
    g(['clone', '-q', origin, other], tmp);
    setTestIdentity(other);
    writeFileSync(join(other, 'upstream.txt'), 'from upstream\n');
    g(['add', '.'], other);
    g(['commit', '-q', '-m', 'upstream commit'], other);
    g(['push', '-q', 'origin', 'main'], other);

    const sid = plantLocalSession(tmp, projectRoot, '{"role":"user","text":"hello world"}\n');

    const { cmdPush } = await import('./commands.push.ts');
    await cmdPush();

    expect(process.exitCode).toBe(0);

    // A fresh clone of origin must contain BOTH the diverged upstream file and
    // the freshly synced session: the push fast-forwarded onto the rebased base.
    const verify = join(tmp, 'verify');
    g(['clone', '-q', origin, verify], tmp);
    expect(existsSync(join(verify, 'upstream.txt'))).toBe(true);
    expect(existsSync(join(verify, 'shared', 'projects', 'testproj', `${sid}.jsonl`))).toBe(true);
  });

  it('blocks the commit and pushes nothing when a staged session carries a secret', async () => {
    const { origin, projectRoot } = buildPushRepo(tmp);
    process.env.HOME = tmp;
    process.env.NOMAD_REPO = join(tmp, 'local');

    const before = gitOut(['rev-list', '--count', 'main'], origin);

    // Assemble a PAT-shaped token at runtime so no contiguous secret sits in
    // source-controlled bytes; the staged-tree gitleaks scan still detects it.
    const fakePat = ['gh', 'p_', 'BCcU4rgWmX3aPlSt9bN6yKzD7vH2eF8oG1qZ'].join('');
    const sid = plantLocalSession(tmp, projectRoot, `{"role":"user","text":"token=${fakePat}"}\n`);

    const { cmdPush } = await import('./commands.push.ts');
    // Non-TTY: the leak verdict aborts via NomadFatal, which cmdPush catches and
    // turns into exitCode 1 (no interactive prompt, no commit, no push).
    await cmdPush();

    expect(process.exitCode).toBe(1);
    // The scan ran BEFORE the commit, so origin never advanced.
    expect(gitOut(['rev-list', '--count', 'main'], origin)).toBe(before);
    // And the secret-bearing transcript was never published.
    const verify = join(tmp, 'verify');
    g(['clone', '-q', origin, verify], tmp);
    expect(existsSync(join(verify, 'shared', 'projects', 'testproj', `${sid}.jsonl`))).toBe(false);
  });
});
