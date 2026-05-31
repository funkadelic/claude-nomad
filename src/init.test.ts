import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { SpawnSyncFn } from './gh-actions.ts';

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

/**
 * A minimal SpawnSyncFn that simulates `git remote get-url origin` returning
 * an existing remote URL, making `ensureOriginRepo` a no-op. All other
 * subprocess calls throw so any unexpected git/gh invocation surfaces as a
 * test failure. `maybeDisableMirrorActions` calls `readOriginRemote` too; the
 * non-GitHub URL ensures it silently skips.
 */
function makeOriginExistsRun(): SpawnSyncFn {
  return (bin, args) => {
    const argv = Array.from(args);
    if (bin === 'git' && argv[0] === 'remote' && argv[1] === 'get-url') {
      return Buffer.from('https://not-github.example.com/owner/repo.git\n');
    }
    throw new Error(`Unexpected subprocess in scaffold test: ${bin} ${argv.join(' ')}`);
  };
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
    cmdInit({ run: makeOriginExistsRun() });
    const repo = join(env.testHome, 'claude-nomad');
    // CLAUDE.md with the documented HTML comment line.
    expect(readFileSync(join(repo, 'shared', 'CLAUDE.md'), 'utf8')).toBe(
      '<!-- claude-nomad shared CLAUDE.md; symlinked into ~/.claude/CLAUDE.md by nomad pull -->\n',
    );
    // Five .gitkeep placeholders under shared/ subdirs, all empty.
    for (const name of ['agents', 'skills', 'commands', 'rules', 'hooks']) {
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
    cmdInit({ run: makeOriginExistsRun() });
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
    const run = makeOriginExistsRun();
    expect(() => cmdInit({ run })).toThrow(NomadFatal);
    try {
      cmdInit({ run });
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('already initialized');
      // Names the offending path.
      expect(msg).toContain(join(repo, 'shared', 'settings.base.json'));
    }
  });

  it('refuses to clobber when shared/ exists even with settings.base.json absent', async () => {
    // Captures the refuse-to-clobber intent: partial state is unsafe; init
    // writes only into a clean target. A bare `shared/` dir is enough to abort.
    const repo = join(env.testHome, 'claude-nomad');
    mkdirSync(join(repo, 'shared'), { recursive: true });
    const { cmdInit } = await import('./init.ts');
    const { NomadFatal } = await import('./utils.ts');
    const run = makeOriginExistsRun();
    expect(() => cmdInit({ run })).toThrow(NomadFatal);
    try {
      cmdInit({ run });
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('already initialized');
      expect(msg).toContain(join(repo, 'shared'));
    }
  });

  it('passes repoName through to ensureOriginRepo (no-op when origin exists)', async () => {
    // When origin already exists, the custom repoName is accepted but ignored by
    // ensureOriginRepo (D-09 idempotency). Scaffold still completes normally.
    const { cmdInit } = await import('./init.ts');
    cmdInit({ run: makeOriginExistsRun(), repoName: 'my-custom-repo' });
    expect(joinedLog(env.logSpy)).toMatch(/init complete$/);
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
    const { classifyRepoState } = await import('./init.classify.ts');
    expect(classifyRepoState(repo, 'test-host')).toBe('empty');
  });

  it('returns "empty" when settings.base.json is absent and path-map.json has zero entries', async () => {
    writeFileSync(join(repo, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    const { classifyRepoState } = await import('./init.classify.ts');
    expect(classifyRepoState(repo, 'test-host')).toBe('empty');
  });

  it('returns "partial" when settings.base.json present but path-map.json missing', async () => {
    writeFileSync(join(repo, 'shared', 'settings.base.json'), '{}\n');
    const { classifyRepoState } = await import('./init.classify.ts');
    expect(classifyRepoState(repo, 'test-host')).toBe('partial');
  });

  it('returns "partial" when settings.base.json + populated path-map but hosts/<host>.json missing', async () => {
    writeFileSync(join(repo, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(
      join(repo, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    const { classifyRepoState } = await import('./init.classify.ts');
    expect(classifyRepoState(repo, 'test-host')).toBe('partial');
  });

  it('returns "populated" when all three signals fire', async () => {
    writeFileSync(join(repo, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(
      join(repo, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    writeFileSync(join(repo, 'hosts', 'test-host.json'), '{}\n');
    const { classifyRepoState } = await import('./init.classify.ts');
    expect(classifyRepoState(repo, 'test-host')).toBe('populated');
  });

  it('treats missing shared/CLAUDE.md as still populated (classifier signals are the three documented files only)', async () => {
    // Missing shared/CLAUDE.md alone does NOT downgrade from populated to
    // partial. The classifier inspects three signals: settings.base.json,
    // path-map.json entries, hosts/<host>.json.
    writeFileSync(join(repo, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(
      join(repo, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    writeFileSync(join(repo, 'hosts', 'test-host.json'), '{}\n');
    // No shared/CLAUDE.md written. Classifier should still report populated.
    expect(existsSync(join(repo, 'shared', 'CLAUDE.md'))).toBe(false);
    const { classifyRepoState } = await import('./init.classify.ts');
    expect(classifyRepoState(repo, 'test-host')).toBe('populated');
  });

  it('treats malformed path-map.json as zero entries instead of throwing', async () => {
    writeFileSync(join(repo, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(join(repo, 'path-map.json'), '{not valid');
    const { classifyRepoState } = await import('./init.classify.ts');
    // settings.base.json present but path-map malformed (treated as zero entries)
    // and hosts/<host>.json missing -> partial.
    expect(classifyRepoState(repo, 'test-host')).toBe('partial');
  });

  it('reasonForPartial returns defensive fallback when all four signals are present (populated state)', async () => {
    // This path is the defensive line that only fires if reasonForPartial is
    // called on a fully-populated repo. Unreachable via classifyRepoState in
    // the normal flow; tested directly to ensure patch coverage.
    writeFileSync(join(repo, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(
      join(repo, 'path-map.json'),
      JSON.stringify({ projects: { x: { 'test-host': '/x' } } }) + '\n',
    );
    writeFileSync(join(repo, 'hosts', 'test-host.json'), '{}\n');
    const { reasonForPartial } = await import('./init.classify.ts');
    expect(reasonForPartial(repo, 'test-host')).toBe('- partial state (unknown gap)');
  });

  it('reasonForPartial reports settings.base.json when basePath is missing (direct call)', async () => {
    // Defensive branch: classifyRepoState would return 'empty' (not 'partial')
    // if basePath is missing, so this line is unreachable via the normal flow.
    // Tested directly to ensure patch coverage of the early-return guard.
    const { reasonForPartial } = await import('./init.classify.ts');
    expect(reasonForPartial(repo, 'test-host')).toBe('- shared/settings.base.json missing');
  });
});

describe('cmdInit snapshot mode', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let env: { testHome: string; logSpy: LogSpy };

  /**
   * Seed `~/.claude/` with the union of files referenced across the snapshot
   * tests. Each test picks the subset it needs; keeps the fixture flat so
   * test bodies stay focused on observable behavior.
   */
  function seedClaudeHome(
    testHome: string,
    parts: {
      claudeMd?: string;
      agents?: Record<string, string>;
      skills?: Record<string, string>;
      commands?: Record<string, string>;
      rules?: Record<string, string>;
      myStatusline?: string;
      settings?: string;
    },
  ): void {
    const claudeDir = join(testHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    if (parts.claudeMd !== undefined) {
      writeFileSync(join(claudeDir, 'CLAUDE.md'), parts.claudeMd);
    }
    for (const [subdir, files] of [
      ['agents', parts.agents],
      ['skills', parts.skills],
      ['commands', parts.commands],
      ['rules', parts.rules],
    ] as const) {
      if (files === undefined) continue;
      mkdirSync(join(claudeDir, subdir), { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(claudeDir, subdir, name), content);
      }
    }
    if (parts.myStatusline !== undefined) {
      writeFileSync(join(claudeDir, 'my-statusline.cjs'), parts.myStatusline);
    }
    if (parts.settings !== undefined) {
      writeFileSync(join(claudeDir, 'settings.json'), parts.settings);
    }
  }

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

  it('copies present SHARED_LINKS into shared/ and keeps .gitkeep where source is absent', async () => {
    seedClaudeHome(env.testHome, {
      claudeMd: '# real claude md\n',
      agents: { 'foo.md': 'foo body\n' },
      skills: { 'bar.md': 'bar body\n' },
      myStatusline: 'module.exports = () => "x";\n',
    });
    const { cmdInit } = await import('./init.ts');
    cmdInit({ snapshot: true, run: makeOriginExistsRun() });
    const repo = join(env.testHome, 'claude-nomad');
    expect(readFileSync(join(repo, 'shared', 'CLAUDE.md'), 'utf8')).toBe('# real claude md\n');
    expect(readFileSync(join(repo, 'shared', 'agents', 'foo.md'), 'utf8')).toBe('foo body\n');
    expect(readFileSync(join(repo, 'shared', 'skills', 'bar.md'), 'utf8')).toBe('bar body\n');
    expect(readFileSync(join(repo, 'shared', 'my-statusline.cjs'), 'utf8')).toBe(
      'module.exports = () => "x";\n',
    );
    // No source for commands/ or rules/, so the .gitkeep placeholders survive.
    expect(readFileSync(join(repo, 'shared', 'commands', '.gitkeep'), 'utf8')).toBe('');
    expect(readFileSync(join(repo, 'shared', 'rules', '.gitkeep'), 'utf8')).toBe('');
    // After a successful copy into agents/ and skills/, the .gitkeep marker
    // was removed because the directory now carries real content.
    expect(existsSync(join(repo, 'shared', 'agents', '.gitkeep'))).toBe(false);
    expect(existsSync(join(repo, 'shared', 'skills', '.gitkeep'))).toBe(false);
  });

  it('writes the verbatim settings.json into hosts/<HOST>.json via writeJsonAtomic', async () => {
    seedClaudeHome(env.testHome, {
      settings: JSON.stringify({ model: 'opus', permissions: { allow: ['fs:read'] } }) + '\n',
    });
    const { cmdInit } = await import('./init.ts');
    cmdInit({ snapshot: true, run: makeOriginExistsRun() });
    const repo = join(env.testHome, 'claude-nomad');
    const hostFile = readFileSync(join(repo, 'hosts', 'test-host.json'), 'utf8');
    // writeJsonAtomic produces 2-space indent + trailing newline.
    expect(hostFile).toBe(
      JSON.stringify({ model: 'opus', permissions: { allow: ['fs:read'] } }, null, 2) + '\n',
    );
    // shared/settings.base.json still contains the empty base; user manually
    // promotes shared keys later.
    expect(readFileSync(join(repo, 'shared', 'settings.base.json'), 'utf8')).toBe('{}\n');
  });

  it('omits hosts/<HOST>.json when ~/.claude/settings.json is absent and keeps the .gitkeep marker', async () => {
    seedClaudeHome(env.testHome, { claudeMd: '# x\n' });
    const { cmdInit } = await import('./init.ts');
    cmdInit({ snapshot: true, run: makeOriginExistsRun() });
    const repo = join(env.testHome, 'claude-nomad');
    expect(existsSync(join(repo, 'hosts', 'test-host.json'))).toBe(false);
    expect(readFileSync(join(repo, 'hosts', '.gitkeep'), 'utf8')).toBe('');
  });

  it('does not modify any file under ~/.claude/', async () => {
    const claudeMdContent = '# real claude md\n';
    const agentContent = 'agent body\n';
    const skillContent = 'skill body\n';
    const statuslineContent = 'module.exports = () => "y";\n';
    const settingsContent = JSON.stringify({ model: 'sonnet', env: { FOO: '1' } }, null, 2) + '\n';
    seedClaudeHome(env.testHome, {
      claudeMd: claudeMdContent,
      agents: { 'a.md': agentContent },
      skills: { 's.md': skillContent },
      myStatusline: statuslineContent,
      settings: settingsContent,
    });
    const claudeDir = join(env.testHome, '.claude');
    // Snapshot the inputs before invocation, then re-read after.
    const before = {
      claudeMd: readFileSync(join(claudeDir, 'CLAUDE.md'), 'utf8'),
      agent: readFileSync(join(claudeDir, 'agents', 'a.md'), 'utf8'),
      skill: readFileSync(join(claudeDir, 'skills', 's.md'), 'utf8'),
      statusline: readFileSync(join(claudeDir, 'my-statusline.cjs'), 'utf8'),
      settings: readFileSync(join(claudeDir, 'settings.json'), 'utf8'),
    };
    const { cmdInit } = await import('./init.ts');
    cmdInit({ snapshot: true, run: makeOriginExistsRun() });
    const after = {
      claudeMd: readFileSync(join(claudeDir, 'CLAUDE.md'), 'utf8'),
      agent: readFileSync(join(claudeDir, 'agents', 'a.md'), 'utf8'),
      skill: readFileSync(join(claudeDir, 'skills', 's.md'), 'utf8'),
      statusline: readFileSync(join(claudeDir, 'my-statusline.cjs'), 'utf8'),
      settings: readFileSync(join(claudeDir, 'settings.json'), 'utf8'),
    };
    expect(after).toEqual(before);
  });

  it('refuses to clobber when shared/settings.base.json already exists', async () => {
    seedClaudeHome(env.testHome, { claudeMd: '# x\n' });
    const repo = join(env.testHome, 'claude-nomad');
    mkdirSync(join(repo, 'shared'), { recursive: true });
    writeFileSync(join(repo, 'shared', 'settings.base.json'), '{"model":"opus"}\n');
    const { cmdInit } = await import('./init.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: Error | undefined;
    try {
      cmdInit({ snapshot: true, run: makeOriginExistsRun() });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect(caught?.message).toContain('already initialized');
  });

  it('emits the documented next-step hint and originals-not-removed log lines', async () => {
    seedClaudeHome(env.testHome, { claudeMd: '# x\n' });
    const { cmdInit } = await import('./init.ts');
    cmdInit({ snapshot: true, run: makeOriginExistsRun() });
    const out = joinedLog(env.logSpy);
    expect(out).toContain(
      "snapshot staged in shared/; review, then 'nomad push' to share with other hosts.",
    );
    expect(out).toContain('~/.claude/ originals were NOT removed.');
    // The Slice A termination line is still emitted last.
    expect(out).toMatch(/init complete$/);
  });

  it('keeps the empty-scaffold behavior intact when cmdInit is called with no opts', async () => {
    // Even with a populated ~/.claude/, plain cmdInit() writes the placeholder
    // shared/CLAUDE.md from Slice A, not the user's real content. Regression
    // guard against the snapshot branch leaking into plain init.
    seedClaudeHome(env.testHome, { claudeMd: '# would-be-snapshotted\n' });
    const { cmdInit } = await import('./init.ts');
    cmdInit({ run: makeOriginExistsRun() });
    const repo = join(env.testHome, 'claude-nomad');
    expect(readFileSync(join(repo, 'shared', 'CLAUDE.md'), 'utf8')).toBe(
      '<!-- claude-nomad shared CLAUDE.md; symlinked into ~/.claude/CLAUDE.md by nomad pull -->\n',
    );
    expect(existsSync(join(repo, 'hosts', 'test-host.json'))).toBe(false);
  });

  it('writes the placeholder shared/CLAUDE.md when ~/.claude/CLAUDE.md is absent', async () => {
    // Snapshot mode with no source CLAUDE.md falls back to the placeholder so
    // the scaffold is still complete; matches the behavior plain init has.
    seedClaudeHome(env.testHome, { agents: { 'x.md': 'x\n' } });
    const { cmdInit } = await import('./init.ts');
    cmdInit({ snapshot: true, run: makeOriginExistsRun() });
    const repo = join(env.testHome, 'claude-nomad');
    expect(readFileSync(join(repo, 'shared', 'CLAUDE.md'), 'utf8')).toBe(
      '<!-- claude-nomad shared CLAUDE.md; symlinked into ~/.claude/CLAUDE.md by nomad pull -->\n',
    );
  });

  it('throws NomadFatal naming the malformed settings file on parse failure', async () => {
    seedClaudeHome(env.testHome, { settings: '{not valid json' });
    const { cmdInit } = await import('./init.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: Error | undefined;
    try {
      cmdInit({ snapshot: true, run: makeOriginExistsRun() });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    // Names the file path so the user can fix it.
    expect(caught?.message).toContain('settings.json');
  });
});

// ---------------------------------------------------------------------------
// maybeDisableMirrorActions (exercised via cmdInit opts.run)
// ---------------------------------------------------------------------------

/** Opts shared by the git and gh dispatch helpers for makeGhRun. */
type GhRunOpts = {
  remote?: string;
  remoteThrows?: true;
  auth?: 'ok' | 'not-installed' | 'not-authed' | 'probe-error';
  isPrivateThrows?: true;
  isPrivate?: boolean;
  actionsEnabledThrows?: true;
  actionsEnabled?: boolean;
  disable?: 'ok' | 'throw';
};

/** Dispatch the `git` bin call for makeGhRun. */
function dispatchGit(opts: GhRunOpts, argv: string[]): Buffer {
  if (argv[0] === 'remote' && argv[1] === 'get-url') {
    if (opts.remoteThrows === true || opts.remote === undefined) {
      throw Object.assign(new Error('no remote'), { code: 128 });
    }
    return Buffer.from(opts.remote + '\n');
  }
  // git init: used by ensureOriginRepo to initialize REPO_HOME before wiring
  // origin when it creates a new repo.
  if (argv[0] === 'init') {
    return Buffer.from('');
  }
  // git remote add: used by ensureOriginRepo when it creates a new repo.
  if (argv[0] === 'remote' && argv[1] === 'add') {
    return Buffer.from('');
  }
  throw new Error(`Unexpected git argv: ${argv.join(' ')}`);
}

/** Simulate `gh auth status` outcomes. */
function dispatchGhStatus(opts: GhRunOpts): Buffer {
  if (opts.auth === 'not-installed') {
    throw Object.assign(new Error('gh ENOENT'), { code: 'ENOENT' });
  }
  if (opts.auth === 'not-authed') {
    // Clean non-zero exit: spawnSync reports the exit code in `status` with no
    // terminating signal. This is the only definitive not-authed signal.
    throw Object.assign(new Error('not authed'), { status: 1, signal: null });
  }
  if (opts.auth === 'probe-error') {
    // Auth-status probe timed out: SIGTERM kill leaves `status` null, so the
    // outcome is indeterminate rather than a definitive not-authed.
    throw Object.assign(new Error('gh ETIMEDOUT'), {
      code: 'ETIMEDOUT',
      signal: 'SIGTERM',
      status: null,
    });
  }
  return Buffer.from('');
}

/** Handle `gh repo view` for isRepoPrivate. */
function dispatchGhView(opts: GhRunOpts): Buffer {
  if (opts.isPrivateThrows === true) throw new Error('api error');
  return Buffer.from(JSON.stringify({ isPrivate: opts.isPrivate }));
}

/** Handle `gh api .../actions/permissions --jq .enabled` for isActionsEnabled. */
function dispatchGhActionsEnabled(opts: GhRunOpts): Buffer {
  if (opts.actionsEnabledThrows === true) throw new Error('api error');
  return Buffer.from(opts.actionsEnabled ? 'true\n' : 'false\n');
}

/** Dispatch the `gh` bin call for makeGhRun. */
function dispatchGh(opts: GhRunOpts, argv: string[]): Buffer {
  if (argv.includes('status')) return dispatchGhStatus(opts);
  // gh repo create: used by ensureOriginRepo on the create path.
  if (argv[0] === 'repo' && argv[1] === 'create') return Buffer.from('');
  // gh api user --jq .login: used by ensureOriginRepo to resolve owner.
  if (argv[0] === 'api' && argv[1] === 'user') return Buffer.from('test-owner\n');
  if (argv.includes('view')) return dispatchGhView(opts);
  if (argv.includes('--jq')) return dispatchGhActionsEnabled(opts);
  if (argv.includes('PUT')) {
    if (opts.disable === 'throw') throw new Error('disable failed');
    return Buffer.from('');
  }
  throw new Error(`Unexpected gh argv: ${argv.join(' ')}`);
}

/**
 * Build a SpawnSyncFn mock that dispatches on (bin, args) to simulate
 * different gh/git subprocess outcomes for maybeDisableMirrorActions paths.
 * Handles ensureOriginRepo subprocesses (repo create, api user, remote add)
 * so those can proceed without interfering with maybeDisableMirrorActions.
 */
function makeGhRun(opts: GhRunOpts): SpawnSyncFn {
  return (bin, args) => {
    const argv = Array.from(args);
    if (bin === 'git') return dispatchGit(opts, argv);
    if (bin === 'gh') return dispatchGh(opts, argv);
    throw new Error(`Unexpected subprocess: ${bin} ${argv.join(' ')}`);
  };
}

describe('maybeDisableMirrorActions (via cmdInit opts.run)', () => {
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

  it('skips silently when git remote get-url always throws (ensureOriginRepo creates, maybeDisableMirrorActions skips)', async () => {
    // When remoteThrows is set, ensureOriginRepo sees no origin -> auth ok ->
    // creates a repo (no-op in the fake runner). Then maybeDisableMirrorActions
    // probes for origin again (same run -> still throws) -> silently skips.
    const { cmdInit } = await import('./init.ts');
    cmdInit({ run: makeGhRun({ remoteThrows: true }) });
    expect(joinedLog(env.logSpy)).toContain('init complete');
  });

  it('skips silently when the remote is not a GitHub URL (parseGitHubRemote returns null)', async () => {
    const { cmdInit } = await import('./init.ts');
    const baseRun = makeGhRun({ remote: 'https://gitlab.com/a/b.git' });
    const runSpy = vi.fn<SpawnSyncFn>(baseRun);
    cmdInit({ run: runSpy });
    expect(joinedLog(env.logSpy)).toContain('init complete');
    // ensureOriginRepo probe returns a non-GitHub URL -> returns immediately.
    // maybeDisableMirrorActions gets the same non-GitHub URL -> skips (no gh calls).
    const ghCalls = runSpy.mock.calls.filter(([bin]) => bin === 'gh');
    expect(ghCalls).toHaveLength(0);
  });

  it('logs gh-CLI tip when gh is not installed', async () => {
    const { cmdInit } = await import('./init.ts');
    cmdInit({ run: makeGhRun({ remote: 'https://github.com/a/b.git', auth: 'not-installed' }) });
    expect(joinedLog(env.logSpy)).toContain('install gh CLI');
  });

  it('logs auth-login tip when gh is installed but not authed', async () => {
    const { cmdInit } = await import('./init.ts');
    cmdInit({ run: makeGhRun({ remote: 'https://github.com/a/b.git', auth: 'not-authed' }) });
    expect(joinedLog(env.logSpy)).toContain('gh auth login');
  });

  it('falls through to the privacy probe on a gh-probe-error, without the auth-login tip (#124)', async () => {
    const { cmdInit } = await import('./init.ts');
    cmdInit({
      run: makeGhRun({
        remote: 'https://github.com/a/b.git',
        auth: 'probe-error',
        isPrivateThrows: true,
      }),
    });
    const joined = joinedLog(env.logSpy);
    // Probe-error is indeterminate, not a definitive not-authed: no auth-login
    // tip, and execution reaches the privacy probe (which then self-reports).
    expect(joined).not.toContain('gh auth login');
    expect(joined).toContain('could not determine privacy for a/b');
  });

  it('logs a manual-fallback tip when isRepoPrivate throws', async () => {
    const { cmdInit } = await import('./init.ts');
    cmdInit({
      run: makeGhRun({ remote: 'https://github.com/a/b.git', auth: 'ok', isPrivateThrows: true }),
    });
    const joined = joinedLog(env.logSpy);
    expect(joined).toContain('could not determine privacy for a/b');
    expect(joined).toContain('init complete');
  });

  it('skips silently when the repo is public', async () => {
    const { cmdInit } = await import('./init.ts');
    cmdInit({
      run: makeGhRun({ remote: 'https://github.com/a/b.git', auth: 'ok', isPrivate: false }),
    });
    expect(joinedLog(env.logSpy)).toContain('init complete');
  });

  it('logs already-disabled message when actions are already off', async () => {
    const { cmdInit } = await import('./init.ts');
    cmdInit({
      run: makeGhRun({
        remote: 'https://github.com/a/b.git',
        auth: 'ok',
        isPrivate: true,
        actionsEnabled: false,
      }),
    });
    expect(joinedLog(env.logSpy)).toContain('already disabled');
  });

  it('treats isActionsEnabled throw as enabled and attempts disable (success path)', async () => {
    const { cmdInit } = await import('./init.ts');
    cmdInit({
      run: makeGhRun({
        remote: 'https://github.com/a/b.git',
        auth: 'ok',
        isPrivate: true,
        actionsEnabledThrows: true,
        disable: 'ok',
      }),
    });
    expect(joinedLog(env.logSpy)).toContain('disabled GitHub Actions');
  });

  it('logs success when actions are enabled and disableActions succeeds', async () => {
    const { cmdInit } = await import('./init.ts');
    cmdInit({
      run: makeGhRun({
        remote: 'https://github.com/a/b.git',
        auth: 'ok',
        isPrivate: true,
        actionsEnabled: true,
        disable: 'ok',
      }),
    });
    expect(joinedLog(env.logSpy)).toContain('disabled GitHub Actions on private mirror');
  });

  it('logs manual-run tip when disableActions throws', async () => {
    const { cmdInit } = await import('./init.ts');
    cmdInit({
      run: makeGhRun({
        remote: 'https://github.com/a/b.git',
        auth: 'ok',
        isPrivate: true,
        actionsEnabled: true,
        disable: 'throw',
      }),
    });
    expect(joinedLog(env.logSpy)).toContain('could not auto-disable');
  });

  it('suppresses all gh activity when keepActions is true', async () => {
    const calls: string[] = [];
    const run: SpawnSyncFn = (bin, args) => {
      const argv = Array.from(args);
      calls.push(`${bin} ${argv.join(' ')}`);
      // git remote get-url: simulate existing origin so ensureOriginRepo is a no-op.
      if (bin === 'git' && argv[0] === 'remote' && argv[1] === 'get-url') {
        return Buffer.from('https://not-github.example.com/owner/repo.git\n');
      }
      throw new Error(`Unexpected: ${bin} ${argv.join(' ')}`);
    };
    const { cmdInit } = await import('./init.ts');
    cmdInit({ keepActions: true, run });
    // Only the ensureOriginRepo probe fires; no gh calls.
    const ghCalls = calls.filter((c) => c.startsWith('gh'));
    expect(ghCalls).toHaveLength(0);
  });
});
