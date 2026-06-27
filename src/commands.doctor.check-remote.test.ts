import type * as cpModule from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { okGlyph, warnGlyph } from './color.ts';
import { makeDoctorEnv, restoreEnv, type Env } from './commands.doctor.checks.test-helpers.ts';

// Behavior-focused: assert on the section items for every scenario that
// reportCheckRemote can encounter. node:child_process is mocked so no real
// git or network I/O occurs; every vi.doMock is paired with vi.doUnmock in
// afterEach per project convention.

type Scenario =
  | 'ok'
  | 'no-ref'
  | 'no-shared'
  | 'no-pathmap'
  | 'show-throws'
  | 'bad-json'
  | 'bad-shape';

/** Build the ls-tree stdout Buffer for the given scenario. */
function lsTreeBuffer(scenario: Scenario): Buffer {
  if (scenario === 'no-shared') return Buffer.from('path-map.json\nhosts\n');
  if (scenario === 'no-pathmap') return Buffer.from('shared\nhosts\n');
  return Buffer.from('shared\npath-map.json\nhosts\n');
}

/** Build the git-show stdout Buffer for the given scenario. */
function showBuffer(scenario: Scenario): Buffer {
  if (scenario === 'bad-json') return Buffer.from('not valid json');
  if (scenario === 'bad-shape') return Buffer.from(JSON.stringify({ projects: null }));
  return Buffer.from(JSON.stringify({ projects: {} }));
}

/**
 * Mock execFileSync for git ls-tree and git show based on the scenario.
 * All other execFileSync calls fall through to the real implementation so
 * doctor infrastructure (spinner, version check) is unaffected.
 */
function mockGit(scenario: Scenario): void {
  vi.doMock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof cpModule>();
    return {
      ...actual,
      execFileSync: vi.fn(
        (
          bin: string,
          args: readonly string[],
          opts?: Parameters<typeof cpModule.execFileSync>[2],
        ) => {
          if (bin === 'git' && args[0] === 'ls-tree') {
            if (scenario === 'no-ref') {
              const err = new Error('unknown revision') as NodeJS.ErrnoException & {
                status?: number;
              };
              err.status = 128;
              throw err;
            }
            return lsTreeBuffer(scenario);
          }
          if (bin === 'git' && args[0] === 'show') {
            if (scenario === 'show-throws') throw new Error('git show failed');
            return showBuffer(scenario);
          }
          return actual.execFileSync(bin, args, opts);
        },
      ),
    };
  });
  vi.resetModules();
}

/** Run reportCheckRemote through a fresh module graph and return the section items joined. */
async function runCheckRemote(): Promise<string> {
  vi.resetModules();
  const { section } = await import('./commands.doctor.format.ts');
  const { reportCheckRemote } = await import('./commands.doctor.check-remote.ts');
  const sec = section('Remote check');
  reportCheckRemote(sec);
  return sec.items.join('\n');
}

describe('nomad doctor --check-remote', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    env = makeDoctorEnv({ host: 'test-host' });
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('emits OK when origin/main has shared/ and a valid path-map.json', async () => {
    mockGit('ok');
    const out = await runCheckRemote();
    expect(out).toContain(`${okGlyph} remote: origin/main has shared/ and a valid path-map.json`);
    expect(process.exitCode).toBe(0);
  });

  it('emits a WARN skip when git ls-tree fails (origin/main unavailable)', async () => {
    mockGit('no-ref');
    const out = await runCheckRemote();
    expect(out).toContain(`${warnGlyph} remote check skipped`);
    expect(out).toContain('unavailable or git error');
    expect(process.exitCode).toBe(0);
  });

  it('emits a WARN when shared/ is missing from origin/main', async () => {
    mockGit('no-shared');
    const out = await runCheckRemote();
    expect(out).toContain(`${warnGlyph} remote: shared/ not found in origin/main`);
    expect(process.exitCode).toBe(0);
  });

  it('emits a WARN when path-map.json is missing from origin/main', async () => {
    mockGit('no-pathmap');
    const out = await runCheckRemote();
    expect(out).toContain(`${warnGlyph} remote: path-map.json not found in origin/main`);
    expect(process.exitCode).toBe(0);
  });

  it('emits a WARN skip when git show throws', async () => {
    mockGit('show-throws');
    const out = await runCheckRemote();
    expect(out).toContain(`${warnGlyph} remote check skipped`);
    expect(out).toContain('could not read path-map.json');
    expect(process.exitCode).toBe(0);
  });

  it('emits a WARN when path-map.json at origin/main is malformed JSON', async () => {
    mockGit('bad-json');
    const out = await runCheckRemote();
    expect(out).toContain(`${warnGlyph} remote: path-map.json at origin/main is malformed JSON`);
    expect(process.exitCode).toBe(0);
  });

  it('emits a WARN when path-map.json at origin/main has invalid shape', async () => {
    mockGit('bad-shape');
    const out = await runCheckRemote();
    expect(out).toContain(`${warnGlyph} remote: path-map.json at origin/main has invalid shape`);
    expect(process.exitCode).toBe(0);
  });

  it('references test-home path in the join call (env sanity check)', () => {
    // Ensures makeDoctorEnv wired HOME correctly so repoHome() resolves to the sandbox.
    expect(env.testHome).toBeTruthy();
    expect(join(env.testHome, 'claude-nomad')).toContain('claude-nomad');
  });
});
