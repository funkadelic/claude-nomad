import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('copyExtras (file-local helper)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let src: string;
  let dst: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-extras-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    src = join(testHome, 'src-tree');
    dst = join(testHome, 'dst-tree');
    mkdirSync(src, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('byte-equal mirror of a plain tree (markdown, JSON, nested text)', async () => {
    writeFileSync(join(src, 'top.md'), '# top\n');
    writeFileSync(join(src, 'top.json'), '{"a":1}\n');
    mkdirSync(join(src, 'nested'), { recursive: true });
    writeFileSync(join(src, 'nested', 'deep.txt'), 'deep-bytes');

    const { copyExtras } = await import('./extras-sync.ts');
    copyExtras(src, dst);

    expect(readFileSync(join(dst, 'top.md'), 'utf8')).toBe('# top\n');
    expect(readFileSync(join(dst, 'top.json'), 'utf8')).toBe('{"a":1}\n');
    expect(readFileSync(join(dst, 'nested', 'deep.txt'), 'utf8')).toBe('deep-bytes');
  });

  it('preserves relative symlink targets verbatim (verbatimSymlinks: true; Pitfall 1)', async () => {
    writeFileSync(join(src, 'target.md'), 'real content\n');
    symlinkSync('target.md', join(src, 'link.md'));

    const { copyExtras } = await import('./extras-sync.ts');
    copyExtras(src, dst);

    // The symlink target must be the original relative string, not rewritten
    // to an absolute path into the source tree (Pitfall 1 mitigation).
    expect(readlinkSync(join(dst, 'link.md'))).toBe('target.md');
  });

  it('propagates empty subdirectories to the destination', async () => {
    mkdirSync(join(src, 'sub', 'empty'), { recursive: true });

    const { copyExtras } = await import('./extras-sync.ts');
    copyExtras(src, dst);

    expect(existsSync(join(dst, 'sub', 'empty'))).toBe(true);
    expect(readdirSync(join(dst, 'sub', 'empty'))).toEqual([]);
  });

  it('mirror semantics: dst-only files are removed (rmSync-then-cpSync)', async () => {
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, 'stale.md'), 'stale\n');
    writeFileSync(join(src, 'fresh.md'), 'fresh\n');

    const { copyExtras } = await import('./extras-sync.ts');
    copyExtras(src, dst);

    expect(readdirSync(dst).sort()).toEqual(['fresh.md']);
    expect(readFileSync(join(dst, 'fresh.md'), 'utf8')).toBe('fresh\n');
  });
});

describe('extras-sync e2e round-trip', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let testRepo: string;
  let hostAHome: string;
  let hostBHome: string;
  let hostAProjectRoot: string;
  let hostBProjectRoot: string;
  let mapPath: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    testRepo = mkdtempSync(join(tmpdir(), 'nomad-extras-e2e-repo-'));
    hostAHome = mkdtempSync(join(tmpdir(), 'nomad-extras-e2e-hostA-'));
    hostBHome = mkdtempSync(join(tmpdir(), 'nomad-extras-e2e-hostB-'));
    hostAProjectRoot = join(hostAHome, 'fake-project');
    hostBProjectRoot = join(hostBHome, 'fake-project');
    mapPath = join(testRepo, 'path-map.json');
    mkdirSync(hostAProjectRoot, { recursive: true });
    mkdirSync(hostBProjectRoot, { recursive: true });
    // Pin the repo location across both hosts via NOMAD_REPO so HOME mutations
    // do not relocate the shared repo between the push and pull halves.
    process.env.NOMAD_REPO = testRepo;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testRepo, { recursive: true, force: true });
    rmSync(hostAHome, { recursive: true, force: true });
    rmSync(hostBHome, { recursive: true, force: true });
  });

  /**
   * Switch the process env to the named host's identity and reset the module
   * graph so the next dynamic import of `./extras-sync.ts` re-evaluates `HOST`
   * and `REPO_HOME` from `./config.ts` against the new env. Both are resolved
   * at module load; without the reset the second host's call would still see
   * the first host's identity.
   */
  function actAsHost(home: string, host: string): void {
    process.env.HOME = home;
    process.env.NOMAD_HOST = host;
    vi.resetModules();
  }

  it('happy path: host A push -> host B pull preserves byte-equality across mixed file types', async () => {
    // Three artifact shapes: top-level markdown, nested-dir markdown, and JSON.
    // The composed round-trip must preserve all three byte-for-byte.
    const stateMd = '# state\n\nactive: phase-19\n';
    const planMd = '# plan\n\nstep 1\nstep 2\n';
    const configJson = '{"feature":"extras","enabled":true}\n';
    mkdirSync(join(hostAProjectRoot, '.planning', 'phases', '01'), { recursive: true });
    writeFileSync(join(hostAProjectRoot, '.planning', 'STATE.md'), stateMd);
    writeFileSync(join(hostAProjectRoot, '.planning', 'phases', '01', 'PLAN.md'), planMd);
    writeFileSync(join(hostAProjectRoot, '.planning', 'config.json'), configJson);
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { demo: { 'host-a': hostAProjectRoot, 'host-b': hostBProjectRoot } },
        extras: { demo: ['.planning'] },
      }) + '\n',
    );

    // Push from host A.
    actAsHost(hostAHome, 'host-a');
    const push = await import('./extras-sync.ts');
    const pushResult = push.remapExtrasPush('20260522-100000');
    expect(pushResult).toEqual({
      unmapped: 0,
      skipped: 0,
      pushed: ['demo/.planning'],
      wouldPush: [],
    });

    // Shared repo now mirrors host A's .planning/ byte-for-byte.
    const sharedState = join(testRepo, 'shared', 'extras', 'demo', '.planning', 'STATE.md');
    const sharedPlan = join(
      testRepo,
      'shared',
      'extras',
      'demo',
      '.planning',
      'phases',
      '01',
      'PLAN.md',
    );
    const sharedCfg = join(testRepo, 'shared', 'extras', 'demo', '.planning', 'config.json');
    expect(readFileSync(sharedState, 'utf8')).toBe(stateMd);
    expect(readFileSync(sharedPlan, 'utf8')).toBe(planMd);
    expect(readFileSync(sharedCfg, 'utf8')).toBe(configJson);

    // Pull on host B.
    actAsHost(hostBHome, 'host-b');
    const pull = await import('./extras-sync.ts');
    const pullResult = pull.remapExtrasPull('20260522-100001');
    expect(pullResult).toEqual({
      unmapped: 0,
      skipped: 0,
      pulled: ['demo/.planning'],
      wouldPull: [],
    });

    // Host B's project root now contains exactly the bytes host A wrote.
    expect(readFileSync(join(hostBProjectRoot, '.planning', 'STATE.md'), 'utf8')).toBe(stateMd);
    expect(
      readFileSync(join(hostBProjectRoot, '.planning', 'phases', '01', 'PLAN.md'), 'utf8'),
    ).toBe(planMd);
    expect(readFileSync(join(hostBProjectRoot, '.planning', 'config.json'), 'utf8')).toBe(
      configJson,
    );
  });

  it('back-compat: legacy path-map without extras key is a clean no-op on push and pull', async () => {
    mkdirSync(join(hostAProjectRoot, '.planning'), { recursive: true });
    writeFileSync(join(hostAProjectRoot, '.planning', 'STATE.md'), '# legacy\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { demo: { 'host-a': hostAProjectRoot, 'host-b': hostBProjectRoot } },
      }) + '\n',
    );

    // Push from host A: no extras key -> clean no-op, shared/extras absent.
    actAsHost(hostAHome, 'host-a');
    const push = await import('./extras-sync.ts');
    const pushResult = push.remapExtrasPush('20260522-100002');
    expect(pushResult).toEqual({ unmapped: 0, skipped: 0, pushed: [], wouldPush: [] });
    expect(existsSync(join(testRepo, 'shared', 'extras', 'demo'))).toBe(false);

    // Pull on host B: same clean no-op, host B's project is untouched.
    actAsHost(hostBHome, 'host-b');
    const pull = await import('./extras-sync.ts');
    const pullResult = pull.remapExtrasPull('20260522-100003');
    expect(pullResult).toEqual({ unmapped: 0, skipped: 0, pulled: [], wouldPull: [] });
    expect(existsSync(join(hostBProjectRoot, '.planning'))).toBe(false);
  });
});
