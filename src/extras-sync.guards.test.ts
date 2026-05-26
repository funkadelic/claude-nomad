import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('assertSafeLogical (path-traversal defense-in-depth)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let projectRoot: string;
  let mapPath: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-extras-safe-logical-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    projectRoot = join(testHome, 'fake-project');
    mapPath = join(repoUnderHome, 'path-map.json');
    mkdirSync(join(repoUnderHome, 'shared', 'extras'), { recursive: true });
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'STATE.md'), '# state\n');
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

  // Each case crafts a path-map.json with a malicious logical key and expects
  // NomadFatal BEFORE any cpSync/write side-effect lands on the filesystem.
  // The push allow-list also catches these eventually, but only after the copy
  // has already mutated state on disk. assertSafeLogical fails fast.
  const malicious = ['../escape', '..', 'foo/bar', 'foo\\bar', '.', 'a/../b'];
  for (const evilKey of malicious) {
    it(`remapExtrasPush rejects logical key ${JSON.stringify(evilKey)} before any write`, async () => {
      writeFileSync(
        mapPath,
        JSON.stringify({
          projects: { [evilKey]: { 'test-host': projectRoot } },
          extras: { [evilKey]: ['.planning'] },
        }) + '\n',
      );
      const { remapExtrasPush } = await import('./extras-sync.ts');
      const { NomadFatal } = await import('./utils.ts');
      expect(() => remapExtrasPush('20260522-evil')).toThrow(NomadFatal);
      // Confirm no escape-write happened (shared/extras stays empty of crafted keys).
      const repoExtras = join(repoUnderHome, 'shared', 'extras');
      const entries = existsSync(repoExtras)
        ? readdirSync(repoExtras).filter((e) => e === evilKey || e === '..' || e === 'escape')
        : [];
      expect(entries).toEqual([]);
    });

    it(`remapExtrasPull rejects logical key ${JSON.stringify(evilKey)} before any write`, async () => {
      // The crafted KEY is what assertSafeLogical must reject (set up under a
      // safe name so the existsSync(src) guard would otherwise pass).
      writeFileSync(
        mapPath,
        JSON.stringify({
          projects: { [evilKey]: { 'test-host': projectRoot } },
          extras: { [evilKey]: ['.planning'] },
        }) + '\n',
      );
      const { remapExtrasPull } = await import('./extras-sync.ts');
      const { NomadFatal } = await import('./utils.ts');
      expect(() => remapExtrasPull('20260522-evil')).toThrow(NomadFatal);
    });

    it(`divergenceCheckExtras rejects logical key ${JSON.stringify(evilKey)} before any git invocation`, async () => {
      writeFileSync(
        mapPath,
        JSON.stringify({
          projects: { [evilKey]: { 'test-host': projectRoot } },
          extras: { [evilKey]: ['.planning'] },
        }) + '\n',
      );
      const { divergenceCheckExtras } = await import('./extras-sync.ts');
      const { NomadFatal } = await import('./utils.ts');
      expect(() => divergenceCheckExtras('20260522-evil')).toThrow(NomadFatal);
    });
  }

  it('remapExtrasPush does not mkdir shared/extras/ when a later map entry is poisoned', async () => {
    // Multi-entry guarantee: a clean logical at the head of the map must NOT
    // let mkdirSync(shared/extras/) (or its first cpSync) land if a poisoned
    // key sits later in iteration order. The up-front validation pass FATALs
    // before any mutation, so the contract holds across the whole map.
    const repoExtras = join(repoUnderHome, 'shared', 'extras');
    // Beat the beforeEach scaffolding so we can prove absence post-call.
    rmSync(repoExtras, { recursive: true, force: true });
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: {
          clean: { 'test-host': projectRoot },
          '../escape': { 'test-host': projectRoot },
        },
        extras: { clean: ['.planning'], '../escape': ['.planning'] },
      }) + '\n',
    );
    const { remapExtrasPush } = await import('./extras-sync.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => remapExtrasPush('20260522-multi-evil')).toThrow(NomadFatal);
    expect(existsSync(repoExtras)).toBe(false);
  });

  it('remapExtrasPull does not clobber host content when a later map entry is poisoned', async () => {
    // Symmetric multi-entry guarantee for pull: a clean head entry must NOT
    // trigger backupExtrasWrite / copyExtras against the host filesystem if a
    // poisoned key sits later. Without the up-front pass, the host-side
    // .planning/ would be replaced (and backed up) before the FATAL fired.
    const repoExtras = join(repoUnderHome, 'shared', 'extras');
    mkdirSync(join(repoExtras, 'clean', '.planning'), { recursive: true });
    writeFileSync(join(repoExtras, 'clean', '.planning', 'STATE.md'), '# incoming\n');
    const localPlanning = join(projectRoot, '.planning');
    mkdirSync(localPlanning, { recursive: true });
    writeFileSync(join(localPlanning, 'STATE.md'), '# original\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: {
          clean: { 'test-host': projectRoot },
          '../escape': { 'test-host': projectRoot },
        },
        extras: { clean: ['.planning'], '../escape': ['.planning'] },
      }) + '\n',
    );
    const { remapExtrasPull } = await import('./extras-sync.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => remapExtrasPull('20260522-pull-multi-evil')).toThrow(NomadFatal);
    // Host content untouched: original file still there, no backup written.
    expect(readFileSync(join(localPlanning, 'STATE.md'), 'utf8')).toBe('# original\n');
    expect(existsSync(join(testHome, '.cache', 'claude-nomad', 'backup'))).toBe(false);
  });

  // localRoot axis: an unnormalized host path would silently land writes at a
  // different absolute path than declared (path.join normalizes '..' before
  // cpSync). assertSafeLocalRoot rejects unnormalized/non-absolute paths before
  // any mutation. /tmp/trailing/ is left out: a trailing slash is benign (not a
  // traversal vector); the check targets '..' and redundant-segment drift.
  const evilLocalRoots = ['/tmp/x/../escape', '/tmp/./redundant', 'relative/path'];
  for (const evilRoot of evilLocalRoots) {
    it(`remapExtrasPush rejects unnormalized localRoot ${JSON.stringify(evilRoot)}`, async () => {
      writeFileSync(
        mapPath,
        JSON.stringify({
          projects: { foo: { 'test-host': evilRoot } },
          extras: { foo: ['.planning'] },
        }) + '\n',
      );
      const { remapExtrasPush } = await import('./extras-sync.ts');
      const { NomadFatal } = await import('./utils.ts');
      expect(() => remapExtrasPush('20260522-evil-root')).toThrow(NomadFatal);
    });

    it(`remapExtrasPull rejects unnormalized localRoot ${JSON.stringify(evilRoot)}`, async () => {
      writeFileSync(
        mapPath,
        JSON.stringify({
          projects: { foo: { 'test-host': evilRoot } },
          extras: { foo: ['.planning'] },
        }) + '\n',
      );
      const { remapExtrasPull } = await import('./extras-sync.ts');
      const { NomadFatal } = await import('./utils.ts');
      expect(() => remapExtrasPull('20260522-evil-root')).toThrow(NomadFatal);
    });
  }

  it('safe logical names pass: ha-acwd, foo_bar, project.name, A1', async () => {
    // Smoke-check the regex isn't accidentally too strict; valid names must all
    // be accepted by push (then short-circuit on the missing extras-source path).
    const safe = ['ha-acwd', 'foo_bar', 'project.name', 'A1'];
    for (const okKey of safe) {
      writeFileSync(
        mapPath,
        JSON.stringify({
          projects: { [okKey]: { 'test-host': projectRoot } },
          extras: { [okKey]: ['.planning'] },
        }) + '\n',
      );
      const { remapExtrasPush } = await import('./extras-sync.ts');
      const r = remapExtrasPush(`20260522-safe-${okKey}`);
      expect(r.unmapped).toBe(0);
      expect(r.skipped).toBe(0);
      vi.resetModules();
    }
  });
});
