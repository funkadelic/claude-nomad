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

import { copyExtrasFilteredPreservingBy } from './extras-sync.core.ts';

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

describe('divergenceCheckExtras early-exit and skip guards', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let testRepo: string;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    testRepo = mkdtempSync(join(tmpdir(), 'nomad-divcheck-repo-'));
    testHome = mkdtempSync(join(tmpdir(), 'nomad-divcheck-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
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
    rmSync(testHome, { recursive: true, force: true });
  });

  it('does NOT throw when path-map.json is absent (L32: null guard on loadValidatedExtras)', async () => {
    // No path-map.json: loadValidatedExtras returns null.
    // A ConditionalExpression-false mutation on L32 would skip the return,
    // passing null to eachExtrasTarget which dereferences null.extrasMap -> TypeError.
    expect(existsSync(join(testRepo, 'path-map.json'))).toBe(false);

    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    expect(() => divergenceCheckExtras('20260516-000000')).not.toThrow();
  });

  it('does NOT warn when only the local side is absent (L40: || not && guard)', async () => {
    // L40: `if (!existsSync(local) || !existsSync(repoEntry)) continue`
    // An && mutation would only skip when BOTH absent; with || it skips when
    // either side is absent. When local is absent but repoEntry exists, the ||
    // guard skips cleanly. With &&, it would proceed to listDivergingFiles where
    // git diff against a missing directory would emit a spurious warn().
    const projectRoot = join(testHome, 'fake-project');
    mkdirSync(projectRoot, { recursive: true });
    // repoEntry (shared/extras/testproj/.planning) exists with content.
    const repoExtras = join(testRepo, 'shared', 'extras', 'testproj', '.planning');
    mkdirSync(repoExtras, { recursive: true });
    writeFileSync(join(repoExtras, 'STATE.md'), '# state\n');
    // local (.planning in projectRoot) does NOT exist.
    expect(existsSync(join(projectRoot, '.planning'))).toBe(false);
    writeFileSync(
      join(testRepo, 'path-map.json'),
      JSON.stringify({
        projects: { testproj: { 'test-host': projectRoot } },
        extras: { testproj: ['.planning'] },
      }) + '\n',
    );

    const warnLines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      warnLines.push(String(chunk));
      return true;
    });

    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    expect(() => divergenceCheckExtras('20260516-000000')).not.toThrow();
    // No warn should be emitted because the local side was absent (early continue).
    const combined = warnLines.join('');
    expect(combined).not.toContain('differs from the synced copy');
  });

  /**
   * Spy on stderr, run `divergenceCheckExtras`, and return the captured output.
   * Shared by the warn-line grammar cases below.
   */
  async function runDivergence(): Promise<string> {
    const warnLines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      warnLines.push(args.map(String).join(' '));
    });
    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    divergenceCheckExtras('20260516-000000');
    return warnLines.join('\n');
  }

  /** Write a path-map.json mapping `testproj` to `projectRoot` with the given extras. */
  function writePathMap(projectRoot: string, extras: string[]): void {
    writeFileSync(
      join(testRepo, 'path-map.json'),
      JSON.stringify({
        projects: { testproj: { 'test-host': projectRoot } },
        extras: { testproj: extras },
      }) + '\n',
    );
  }

  it('warns "folder" with plural grammar for a multi-file directory divergence', async () => {
    const projectRoot = join(testHome, 'proj-folder-plural');
    const localPlanning = join(projectRoot, '.planning');
    mkdirSync(localPlanning, { recursive: true });
    writeFileSync(join(localPlanning, 'a.md'), 'local-a\n');
    writeFileSync(join(localPlanning, 'b.md'), 'local-b\n');
    const repoExtras = join(testRepo, 'shared', 'extras', 'testproj', '.planning');
    mkdirSync(repoExtras, { recursive: true });
    writeFileSync(join(repoExtras, 'a.md'), 'repo-a\n');
    writeFileSync(join(repoExtras, 'b.md'), 'repo-b\n');
    writePathMap(projectRoot, ['.planning']);

    const combined = await runDivergence();
    expect(combined).toContain(
      'local folder .planning/ in repo testproj differs from the synced copy in 2 files;',
    );
    expect(combined).toContain('overwrite them with the synced version');
    expect(combined).toContain('your current files are backed up to');
  });

  it('warns "folder" with singular grammar for a single-file directory divergence', async () => {
    const projectRoot = join(testHome, 'proj-folder-single');
    const localPlanning = join(projectRoot, '.planning');
    mkdirSync(localPlanning, { recursive: true });
    writeFileSync(join(localPlanning, 'a.md'), 'local-a\n');
    const repoExtras = join(testRepo, 'shared', 'extras', 'testproj', '.planning');
    mkdirSync(repoExtras, { recursive: true });
    writeFileSync(join(repoExtras, 'a.md'), 'repo-a\n');
    writePathMap(projectRoot, ['.planning']);

    const combined = await runDivergence();
    expect(combined).toContain(
      'local folder .planning/ in repo testproj differs from the synced copy in 1 file;',
    );
    expect(combined).toContain('overwrite it with the synced version');
    expect(combined).toContain('your current file is backed up to');
  });

  it('warns "file" for a single-file extra (CLAUDE.md) divergence', async () => {
    const projectRoot = join(testHome, 'proj-file');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, 'CLAUDE.md'), 'local\n');
    const repoExtras = join(testRepo, 'shared', 'extras', 'testproj');
    mkdirSync(repoExtras, { recursive: true });
    writeFileSync(join(repoExtras, 'CLAUDE.md'), 'repo\n');
    writePathMap(projectRoot, ['CLAUDE.md']);

    const combined = await runDivergence();
    expect(combined).toContain(
      'local file CLAUDE.md in repo testproj differs from the synced copy in 1 file;',
    );
  });
});

describe('copyExtrasFilteredPreservingBy (predicate-driven preserving overlay)', () => {
  let tmp: string;
  let src: string;
  let dst: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-preservingby-'));
    src = join(tmp, 'src');
    dst = join(tmp, 'dst');
    mkdirSync(src, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('preserves a dst-only entry that matches the predicate (load-bearing invariant)', () => {
    // The entry 'keep-me' exists ONLY in dst, absent from src, but the
    // predicate returns true for it. It must survive the overlay.
    mkdirSync(join(dst, 'keep-me'), { recursive: true });
    writeFileSync(join(dst, 'keep-me', 'data.txt'), 'preserve me\n');

    mkdirSync(join(src, 'overlay-me'), { recursive: true });
    writeFileSync(join(src, 'overlay-me', 'data.txt'), 'new content\n');

    copyExtrasFilteredPreservingBy(src, dst, (name) => name === 'keep-me');

    expect(existsSync(join(dst, 'keep-me'))).toBe(true);
    expect(readFileSync(join(dst, 'keep-me', 'data.txt'), 'utf8')).toBe('preserve me\n');
    expect(existsSync(join(dst, 'overlay-me'))).toBe(true);
  });

  it('removes a dst entry absent from src when the predicate returns false', () => {
    // A non-preserved dst entry absent from src is stale and must be removed.
    mkdirSync(join(dst, 'stale'), { recursive: true });
    writeFileSync(join(dst, 'stale', 'old.txt'), 'stale\n');

    mkdirSync(join(src, 'fresh'), { recursive: true });
    writeFileSync(join(src, 'fresh', 'new.txt'), 'new\n');

    copyExtrasFilteredPreservingBy(src, dst, (name) => name === 'preserve-only-this');

    expect(existsSync(join(dst, 'stale'))).toBe(false);
    expect(existsSync(join(dst, 'fresh'))).toBe(true);
  });

  it('does NOT copy a src entry matching the predicate into dst (defense-in-depth)', () => {
    // An entry in src that the predicate marks as preserved must not be copied.
    mkdirSync(join(src, 'blocked'), { recursive: true });
    writeFileSync(join(src, 'blocked', 'secret.txt'), 'secret\n');
    mkdirSync(join(src, 'allowed'), { recursive: true });
    writeFileSync(join(src, 'allowed', 'data.txt'), 'data\n');

    copyExtrasFilteredPreservingBy(src, dst, (name) => name === 'blocked');

    expect(existsSync(join(dst, 'blocked'))).toBe(false);
    expect(existsSync(join(dst, 'allowed'))).toBe(true);
  });

  it('creates dst when it does not exist (fresh pull)', () => {
    mkdirSync(join(src, 'item'), { recursive: true });
    writeFileSync(join(src, 'item', 'file.txt'), 'hello\n');
    expect(existsSync(dst)).toBe(false);

    copyExtrasFilteredPreservingBy(src, dst, () => false);

    expect(existsSync(join(dst, 'item'))).toBe(true);
    expect(readFileSync(join(dst, 'item', 'file.txt'), 'utf8')).toBe('hello\n');
  });

  it('replaces a non-directory dst root (file/symlink) wholesale before copying', () => {
    // dst is a file, not a directory: must be removed before cpSync recreates it.
    writeFileSync(dst, 'i am a file not a dir\n');
    mkdirSync(join(src, 'item'), { recursive: true });
    writeFileSync(join(src, 'item', 'file.txt'), 'hello\n');

    copyExtrasFilteredPreservingBy(src, dst, () => false);

    expect(existsSync(join(dst, 'item'))).toBe(true);
  });

  it('recurses into matching sub-directories and removes stale nested entries', () => {
    // dst has a sub-directory 'sub' with a stale nested file; src/sub has only fresh content.
    mkdirSync(join(dst, 'sub'), { recursive: true });
    writeFileSync(join(dst, 'sub', 'stale.txt'), 'stale\n');
    writeFileSync(join(dst, 'sub', 'keep.txt'), 'keep\n');
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'sub', 'fresh.txt'), 'fresh\n');
    // 'keep.txt' is in dst but absent from src/sub, and predicate returns false
    // for 'keep.txt', so it should be removed by the prune pass.

    copyExtrasFilteredPreservingBy(src, dst, () => false);

    expect(existsSync(join(dst, 'sub', 'fresh.txt'))).toBe(true);
    expect(existsSync(join(dst, 'sub', 'stale.txt'))).toBe(false);
    expect(existsSync(join(dst, 'sub', 'keep.txt'))).toBe(false);
  });

  it('removes a dst entry when src has the same name as a file but dst has it as a dir', () => {
    // Type mismatch: src has 'item' as a file, dst has 'item' as a directory.
    // The type-mismatch branch removes dst/item so cpSync can replace it.
    mkdirSync(join(dst, 'item'), { recursive: true });
    writeFileSync(join(dst, 'item', 'nested.txt'), 'nested\n');
    writeFileSync(join(src, 'item'), 'i am a file now\n');

    copyExtrasFilteredPreservingBy(src, dst, () => false);

    // After copy, dst/item should be the file from src, not the old directory.
    expect(readFileSync(join(dst, 'item'), 'utf8')).toBe('i am a file now\n');
  });

  it('overwrites a dst file with a src file of the same name (both non-directories, no-op in prune)', () => {
    // Both src and dst have 'file.txt' as a plain file. The prune pass takes no
    // action (neither removes it nor recurses); cpSync overwrites the content.
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, 'file.txt'), 'old content\n');
    writeFileSync(join(src, 'file.txt'), 'new content\n');

    copyExtrasFilteredPreservingBy(src, dst, () => false);

    expect(readFileSync(join(dst, 'file.txt'), 'utf8')).toBe('new content\n');
  });
});
