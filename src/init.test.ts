import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

type LogSpy = MockInstance<(...args: unknown[]) => void>;

/**
 * Sandbox the env for `cmdInit` tests by pointing HOME at a fresh temp dir and
 * resetting the module cache so `./init.ts` re-reads `REPO_HOME` from the
 * mutated HOME. The pattern mirrors `src/links.test.ts` and the dynamic-import
 * convention shared by every command-level test in this repo.
 */
function makeInitEnv(): { testHome: string; logSpy: LogSpy } {
  const testHome = mkdtempSync(join(tmpdir(), 'nomad-init-'));
  process.env.HOME = testHome;
  vi.resetModules();
  const logSpy = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
    /* captured */
  });
  return { testHome, logSpy };
}

/** Join captured `console.log` calls into one newline-separated string. */
function joinedLog(logSpy: LogSpy): string {
  return logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
}

describe('cmdInit empty-scaffold mode', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let env: { testHome: string; logSpy: LogSpy };

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    process.env.NOMAD_HOST = 'test-host';
    env = makeInitEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('writes the documented scaffold files into a fresh REPO_HOME', async () => {
    const { cmdInit } = await import('./init.ts');
    cmdInit();
    const repo = join(env.testHome, 'claude-nomad');
    // CLAUDE.md with the documented HTML comment line.
    expect(readFileSync(join(repo, 'shared', 'CLAUDE.md'), 'utf8')).toBe(
      '<!-- claude-nomad shared CLAUDE.md; symlinked into ~/.claude/CLAUDE.md by nomad pull -->\n',
    );
    // Four .gitkeep placeholders under shared/ subdirs, all empty.
    for (const name of ['agents', 'skills', 'commands', 'rules']) {
      expect(readFileSync(join(repo, 'shared', name, '.gitkeep'), 'utf8')).toBe('');
    }
    // hosts/.gitkeep is also empty.
    expect(readFileSync(join(repo, 'hosts', '.gitkeep'), 'utf8')).toBe('');
    // settings.base.json is exactly `{}\n` (writeJsonAtomic emits no indent for an empty obj).
    expect(readFileSync(join(repo, 'shared', 'settings.base.json'), 'utf8')).toBe('{}\n');
    // path-map.json at the repo root (NOT under shared/) is the 2-space indented form.
    expect(readFileSync(join(repo, 'path-map.json'), 'utf8')).toBe(
      JSON.stringify({ projects: {} }, null, 2) + '\n',
    );
  });

  it('emits a final log line that ends with "init complete"', async () => {
    const { cmdInit } = await import('./init.ts');
    cmdInit();
    const out = joinedLog(env.logSpy);
    // The final summary line. Phrasing is implementation choice; the literal
    // tail `init complete` is the contractual marker per the plan's behavior 2.
    expect(out).toMatch(/init complete$/);
  });

  it('refuses to clobber when shared/settings.base.json already exists', async () => {
    const repo = join(env.testHome, 'claude-nomad');
    mkdirSync(join(repo, 'shared'), { recursive: true });
    writeFileSync(join(repo, 'shared', 'settings.base.json'), '{"model":"opus"}\n');
    const { cmdInit } = await import('./init.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => cmdInit()).toThrow(NomadFatal);
    try {
      cmdInit();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('already initialized');
      // Names the offending path.
      expect(msg).toContain(join(repo, 'shared', 'settings.base.json'));
    }
  });

  it('refuses to clobber when shared/ exists even with settings.base.json absent', async () => {
    // Captures D-01 intent: partial state is unsafe; init writes only into a
    // clean target. A bare `shared/` dir is enough to abort.
    const repo = join(env.testHome, 'claude-nomad');
    mkdirSync(join(repo, 'shared'), { recursive: true });
    const { cmdInit } = await import('./init.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => cmdInit()).toThrow(NomadFatal);
    try {
      cmdInit();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('already initialized');
      expect(msg).toContain(join(repo, 'shared'));
    }
  });
});

describe('classifyRepoState classifier', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repo: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    process.env.NOMAD_HOST = 'test-host';
    testHome = mkdtempSync(join(tmpdir(), 'nomad-classify-'));
    process.env.HOME = testHome;
    repo = join(testHome, 'claude-nomad');
    mkdirSync(join(repo, 'shared'), { recursive: true });
    mkdirSync(join(repo, 'hosts'), { recursive: true });
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

  it('returns "empty" when settings.base.json is absent and path-map.json missing', async () => {
    const { classifyRepoState } = await import('./init.ts');
    expect(classifyRepoState(repo, 'test-host')).toBe('empty');
  });

  it('returns "empty" when settings.base.json is absent and path-map.json has zero entries', async () => {
    writeFileSync(join(repo, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    const { classifyRepoState } = await import('./init.ts');
    expect(classifyRepoState(repo, 'test-host')).toBe('empty');
  });

  it('returns "partial" when settings.base.json present but path-map.json missing', async () => {
    writeFileSync(join(repo, 'shared', 'settings.base.json'), '{}\n');
    const { classifyRepoState } = await import('./init.ts');
    expect(classifyRepoState(repo, 'test-host')).toBe('partial');
  });

  it('returns "partial" when settings.base.json + populated path-map but hosts/<host>.json missing', async () => {
    writeFileSync(join(repo, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(
      join(repo, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    const { classifyRepoState } = await import('./init.ts');
    expect(classifyRepoState(repo, 'test-host')).toBe('partial');
  });

  it('returns "populated" when all three signals fire', async () => {
    writeFileSync(join(repo, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(
      join(repo, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    writeFileSync(join(repo, 'hosts', 'test-host.json'), '{}\n');
    const { classifyRepoState } = await import('./init.ts');
    expect(classifyRepoState(repo, 'test-host')).toBe('populated');
  });

  it('treats missing shared/CLAUDE.md as still populated (classifier signals are the three documented files only)', async () => {
    // D-04: missing shared/CLAUDE.md alone does NOT downgrade from populated
    // to partial. The classifier inspects three signals: settings.base.json,
    // path-map.json entries, hosts/<host>.json.
    writeFileSync(join(repo, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(
      join(repo, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    writeFileSync(join(repo, 'hosts', 'test-host.json'), '{}\n');
    // No shared/CLAUDE.md written. Classifier should still report populated.
    expect(existsSync(join(repo, 'shared', 'CLAUDE.md'))).toBe(false);
    const { classifyRepoState } = await import('./init.ts');
    expect(classifyRepoState(repo, 'test-host')).toBe('populated');
  });

  it('treats malformed path-map.json as zero entries instead of throwing', async () => {
    writeFileSync(join(repo, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(join(repo, 'path-map.json'), '{not valid');
    const { classifyRepoState } = await import('./init.ts');
    // settings.base.json present but path-map malformed (treated as zero entries)
    // and hosts/<host>.json missing -> partial.
    expect(classifyRepoState(repo, 'test-host')).toBe('partial');
  });
});
