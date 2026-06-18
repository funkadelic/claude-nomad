import {
  existsSync,
  lstatSync,
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

describe('regenerateSettings (integration)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let hostsDir: string;
  let sharedDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedDir = join(repoUnderHome, 'shared');
    hostsDir = join(repoUnderHome, 'hosts');
    claudeDir = join(testHome, '.claude');
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(hostsDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
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

  it('writes settings.json with base + host overrides applied', async () => {
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(join(hostsDir, 'test-host.json'), JSON.stringify({ hooks: {} }) + '\n');
    const { regenerateSettings } = await import('./links.ts');
    const result = regenerateSettings('20260516-000000');
    const written = readFileSync(join(claudeDir, 'settings.json'), 'utf8');
    expect(written).toBe(JSON.stringify({ model: 'sonnet', hooks: {} }, null, 2) + '\n');
    // The wet success log moved to a returned label (cmdPull renders the
    // Settings tree row from it). With a host override present the label is
    // `<HOST>.json`.
    expect(result).toEqual({ label: 'test-host.json' });
  });

  it('returns the no-overrides label when no host file matches', async () => {
    // No hosts/test-host.json: the returned label is `no host overrides`,
    // which cmdPull renders as `✓ settings.json (base + no host overrides)`.
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    const { regenerateSettings } = await import('./links.ts');
    const result = regenerateSettings('20260516-000000');
    expect(result).toEqual({ label: 'no host overrides' });
  });

  it('leaves no .tmp sibling after a successful atomic write', async () => {
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(join(hostsDir, 'test-host.json'), JSON.stringify({ hooks: {} }) + '\n');
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260516-000000');
    const leftovers = readdirSync(claudeDir).filter((f) => f.startsWith('settings.json.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('snapshots the prior settings.json to ~/.cache/.../backup/<ts>/ before overwrite', async () => {
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(join(hostsDir, 'test-host.json'), JSON.stringify({ hooks: {} }) + '\n');
    const priorContent = JSON.stringify({ model: 'opus', old: true }) + '\n';
    writeFileSync(join(claudeDir, 'settings.json'), priorContent);
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260516-000000');
    const backupPath = join(
      testHome,
      '.cache',
      'claude-nomad',
      'backup',
      '20260516-000000',
      'settings.json',
    );
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, 'utf8')).toBe(priorContent);
    const newContent = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(newContent).toEqual({ model: 'sonnet', hooks: {} });
  });

  it('fires ahead-drift WARN advising nomad capture-settings when settings has local-only keys', async () => {
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ model: 'opus', statusLine: { type: 'command' } }) + '\n',
    );
    // warn() routes through console.error; capture both stdio paths so the
    // assertion remains stream-agnostic.
    const writes: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      writes.push(args.map(String).join(' ') + '\n');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260516-000000');
    const captured = writes.join('');
    expect(captured).toContain('nomad capture-settings');
    expect(captured).toContain('statusLine');
    expect(existsSync(join(claudeDir, 'settings.json'))).toBe(true);
  });

  it('suppresses the drift WARN when suppressDriftWarn is set (post-capture resync)', async () => {
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    // settings has a local-only key that would normally fire the ahead-drift WARN.
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ model: 'opus', statusLine: { type: 'command' } }) + '\n',
    );
    const writes: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      writes.push(args.map(String).join(' ') + '\n');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260516-000000', { suppressDriftWarn: true });
    const captured = writes.join('');
    expect(captured).not.toContain('nomad capture-settings');
    expect(captured).not.toContain('⚠︎');
    // The resync still happens.
    expect(existsSync(join(claudeDir, 'settings.json'))).toBe(true);
  });

  it('does NOT fire WARN when host file is missing but prior settings only has base keys', async () => {
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ model: 'opus' }) + '\n');
    const writes: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      writes.push(args.map(String).join(' ') + '\n');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260516-000000');
    expect(writes.join('')).not.toContain('⚠︎');
  });

  it('regenerates settings even when prior settings.json is malformed JSON', async () => {
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(join(claudeDir, 'settings.json'), '{ this is not, valid json');
    const writes: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      writes.push(args.map(String).join(' ') + '\n');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const { regenerateSettings } = await import('./links.ts');
    expect(() => regenerateSettings('20260516-000000')).not.toThrow();
    expect(writes.join('')).toContain('⚠︎ existing settings.json is malformed');
    expect(JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'))).toEqual({
      model: 'sonnet',
    });
  });

  // First-run FATAL phrasing replaces the bare `missing <path>` die when
  // shared/settings.base.json is absent. The canonical message text MUST
  // contain `repo not initialized` and reference `nomad init` so users
  // recover from a fresh-host pull without reading the README. A future
  // slice will extend the message to mention the snapshot mode once that
  // verb is wired into the dispatcher.
  it('dies with the init-hint phrasing when shared/settings.base.json is missing', async () => {
    // No settings.base.json written; sandbox HOME is otherwise normal.
    const { regenerateSettings } = await import('./links.ts');
    expect(() => regenerateSettings('20260516-000000')).toThrow(
      "repo not initialized; run 'nomad init' to scaffold",
    );
  });

  it('fires behind-drift WARN advising nomad pull when merged keys are missing from settings', async () => {
    // behind-drift: merged has a key that is absent from settings -> pull hint
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet', hooks: {} }) + '\n',
    );
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ model: 'sonnet' }) + '\n');
    const writes: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      writes.push(args.map(String).join(' ') + '\n');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260516-000000');
    const captured = writes.join('');
    expect(captured).toContain('nomad pull');
    expect(captured).toContain('hooks');
    expect(captured).not.toContain('nomad capture-settings');
  });

  it('does NOT fire any drift WARN when settings exactly matches merged', async () => {
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ model: 'sonnet' }) + '\n');
    const writes: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      writes.push(args.map(String).join(' ') + '\n');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260516-000000');
    const captured = writes.join('');
    expect(captured).not.toContain('⚠︎');
  });

  it('fires direction-aware WARNs when a host override exists and settings has both missing and ahead-only keys', async () => {
    // Direction-aware drift: with a host override present and a settings that
    // diverges both ways, both behind-drift (nomad pull) and ahead-drift
    // (nomad capture-settings) WARNs are emitted.
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    // Host override file exists.
    writeFileSync(join(hostsDir, 'test-host.json'), JSON.stringify({ hooks: {} }) + '\n');
    // merged = { model: 'sonnet', hooks: {} }
    // settings has statusLine (ahead) and model changed, but hooks is behind (missing).
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ model: 'opus', statusLine: { type: 'command' } }) + '\n',
    );
    const writes: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      writes.push(args.map(String).join(' ') + '\n');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260516-000000');
    const captured = writes.join('');
    // behind: hooks is missing from settings -> nomad pull
    expect(captured).toContain('nomad pull');
    expect(captured).toContain('hooks');
    // ahead: statusLine is local-only -> nomad capture-settings
    expect(captured).toContain('nomad capture-settings');
    expect(captured).toContain('statusLine');
  });

  it('does NOT advise capture when settings is ahead only via a capture-excluded key', async () => {
    // ahead-only drift whose sole local-only key is excluded from capture (env):
    // advising nomad capture-settings would be a no-op and would name a
    // secret-bearing key, so no ahead-drift WARN fires.
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ model: 'sonnet', env: { ANTHROPIC_API_KEY: 'sk-secret' } }) + '\n',
    );
    const writes: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      writes.push(args.map(String).join(' ') + '\n');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260516-000000');
    const captured = writes.join('');
    expect(captured).not.toContain('nomad capture-settings');
    expect(captured).not.toContain('env');
  });
});

describe('applySharedLinks auto-move', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let sharedDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedDir = join(repoUnderHome, 'shared');
    claudeDir = join(testHome, '.claude');
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
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

  it('backs up a pre-existing real DIR and replaces it with a symlink in one call (commands)', async () => {
    // skills is no longer in SHARED_LINKS (copy-synced via syncSkillsPull/Push); use commands instead.
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
    writeFileSync(join(sharedDir, 'commands', 'foo.md'), '# shared command\n');
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'preexisting.md'), '# local content\n');

    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260516-000000', { projects: {} });

    const backupFile = join(
      testHome,
      '.cache',
      'claude-nomad',
      'backup',
      '20260516-000000',
      'commands',
      'preexisting.md',
    );
    expect(existsSync(backupFile)).toBe(true);
    expect(readFileSync(backupFile, 'utf8')).toBe('# local content\n');

    const linkPath = join(claudeDir, 'commands');
    const linkStat = lstatSync(linkPath);
    expect(linkStat.isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(join(sharedDir, 'commands'));
  });

  it('does NOT create a symlink for skills (copy-synced, dropped from SHARED_LINKS)', async () => {
    // skills was removed from SHARED_LINKS; applySharedLinks must leave a pre-existing
    // local ~/.claude/skills dir completely untouched (no backup, no symlink).
    mkdirSync(join(sharedDir, 'skills'), { recursive: true });
    writeFileSync(join(sharedDir, 'skills', 'graphify'), '# graphify\n');
    mkdirSync(join(claudeDir, 'skills'), { recursive: true });
    writeFileSync(join(claudeDir, 'skills', 'local.md'), '# local\n');
    // Ensure at least one SHARED_LINKS source exists so the function is not a no-op.
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');

    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260516-000000', { projects: {} });

    // ~/.claude/skills must still be a plain directory (not a symlink).
    const skillsPath = join(claudeDir, 'skills');
    expect(lstatSync(skillsPath).isDirectory()).toBe(true);
    expect(lstatSync(skillsPath).isSymbolicLink()).toBe(false);

    // No backup was made for skills.
    const backupSkills = join(
      testHome,
      '.cache',
      'claude-nomad',
      'backup',
      '20260516-000000',
      'skills',
    );
    expect(existsSync(backupSkills)).toBe(false);
  });

  it('does NOT create a symlink for agents (gsd-owned, dropped from SHARED_LINKS)', async () => {
    // agents was removed from SHARED_LINKS; applySharedLinks must leave a pre-existing
    // local ~/.claude/agents dir completely untouched (no backup, no symlink).
    mkdirSync(join(sharedDir, 'agents'), { recursive: true });
    writeFileSync(join(sharedDir, 'agents', 'gsd-agent.md'), '# gsd\n');
    mkdirSync(join(claudeDir, 'agents'), { recursive: true });
    writeFileSync(join(claudeDir, 'agents', 'local.md'), '# local\n');
    // Ensure at least one SHARED_LINKS source exists so the function is not a no-op.
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');

    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260516-000000', { projects: {} });

    // ~/.claude/agents must still be a plain directory (not a symlink).
    const agentsPath = join(claudeDir, 'agents');
    expect(lstatSync(agentsPath).isDirectory()).toBe(true);
    expect(lstatSync(agentsPath).isSymbolicLink()).toBe(false);
    // No backup was made for agents.
    const backupAgents = join(
      testHome,
      '.cache',
      'claude-nomad',
      'backup',
      '20260516-000000',
      'agents',
    );
    expect(existsSync(backupAgents)).toBe(false);
  });

  it('does NOT create a symlink for hooks (gsd-owned, dropped from SHARED_LINKS)', async () => {
    // hooks was removed from SHARED_LINKS for the same reason as agents.
    mkdirSync(join(sharedDir, 'hooks'), { recursive: true });
    writeFileSync(join(sharedDir, 'hooks', 'gsd-hook.sh'), '#!/bin/sh\n');
    mkdirSync(join(claudeDir, 'hooks'), { recursive: true });
    writeFileSync(join(claudeDir, 'hooks', 'local.sh'), '#!/bin/sh\n');
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');

    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260516-000000', { projects: {} });

    const hooksPath = join(claudeDir, 'hooks');
    expect(lstatSync(hooksPath).isDirectory()).toBe(true);
    expect(lstatSync(hooksPath).isSymbolicLink()).toBe(false);
    const backupHooks = join(
      testHome,
      '.cache',
      'claude-nomad',
      'backup',
      '20260516-000000',
      'hooks',
    );
    expect(existsSync(backupHooks)).toBe(false);
  });

  it('backs up a pre-existing real FILE (CLAUDE.md) and replaces it with a symlink', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# new\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# old\n');

    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260516-000000', { projects: {} });

    const backupFile = join(
      testHome,
      '.cache',
      'claude-nomad',
      'backup',
      '20260516-000000',
      'CLAUDE.md',
    );
    expect(existsSync(backupFile)).toBe(true);
    expect(readFileSync(backupFile, 'utf8')).toBe('# old\n');

    const linkPath = join(claudeDir, 'CLAUDE.md');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(join(sharedDir, 'CLAUDE.md'));
  });

  it('leaves pre-existing CORRECT symlinks alone and creates no backup (idempotent)', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
    const sharedTarget = join(sharedDir, 'CLAUDE.md');
    const linkPath = join(claudeDir, 'CLAUDE.md');
    symlinkSync(sharedTarget, linkPath);

    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260516-000000', { projects: {} });

    const backupFile = join(
      testHome,
      '.cache',
      'claude-nomad',
      'backup',
      '20260516-000000',
      'CLAUDE.md',
    );
    expect(existsSync(backupFile)).toBe(false);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(sharedTarget);
  });

  it('leaves local SHARED_LINK content alone when repo has no counterpart', async () => {
    // shared/commands/ does NOT exist in the repo. ~/.claude/commands/ has
    // local content. Pre-fix, the first loop would back up and delete the
    // local dir; the second loop would NOT recreate it. Post-fix, both loops
    // skip names without a repo counterpart so the local dir survives.
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'local-only.md'), '# local-only\n');
    // Sanity: at least one OTHER shared link MUST be a real symlinkable
    // target so the function does something on the happy paths. Writing
    // shared/CLAUDE.md so the test does not regress to a no-op.
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');

    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260516-000000', { projects: {} });

    expect(existsSync(join(claudeDir, 'commands', 'local-only.md'))).toBe(true);
    expect(readFileSync(join(claudeDir, 'commands', 'local-only.md'), 'utf8')).toBe(
      '# local-only\n',
    );
    expect(lstatSync(join(claudeDir, 'commands')).isDirectory()).toBe(true);
    expect(lstatSync(join(claudeDir, 'commands')).isSymbolicLink()).toBe(false);
    // CLAUDE.md is still symlinked as expected.
    expect(lstatSync(join(claudeDir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    // And no backup of commands/ was made (since we never touched it).
    const backupCommands = join(
      testHome,
      '.cache',
      'claude-nomad',
      'backup',
      '20260516-000000',
      'commands',
    );
    expect(existsSync(backupCommands)).toBe(false);
  });

  it('handles multiple non-symlink conflicts in a single pass (rules + commands)', async () => {
    // skills is no longer in SHARED_LINKS; use rules + commands to cover the multi-conflict path.
    mkdirSync(join(sharedDir, 'rules'), { recursive: true });
    writeFileSync(join(sharedDir, 'rules', 's.md'), '# shared rules\n');
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
    writeFileSync(join(sharedDir, 'commands', 'c.md'), '# shared c\n');

    mkdirSync(join(claudeDir, 'rules'), { recursive: true });
    writeFileSync(join(claudeDir, 'rules', 'bar.md'), '# local rules\n');
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'baz.md'), '# local commands\n');

    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260516-000000', { projects: {} });

    const rulesLink = join(claudeDir, 'rules');
    const commandsLink = join(claudeDir, 'commands');
    expect(lstatSync(rulesLink).isSymbolicLink()).toBe(true);
    expect(lstatSync(commandsLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(rulesLink)).toBe(join(sharedDir, 'rules'));
    expect(readlinkSync(commandsLink)).toBe(join(sharedDir, 'commands'));

    const backupRoot = join(testHome, '.cache', 'claude-nomad', 'backup', '20260516-000000');
    expect(existsSync(join(backupRoot, 'rules', 'bar.md'))).toBe(true);
    expect(existsSync(join(backupRoot, 'commands', 'baz.md'))).toBe(true);
    expect(readFileSync(join(backupRoot, 'rules', 'bar.md'), 'utf8')).toBe('# local rules\n');
    expect(readFileSync(join(backupRoot, 'commands', 'baz.md'), 'utf8')).toBe('# local commands\n');
  });
});

describe('applySharedLinks dry-run', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let sharedDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedDir = join(repoUnderHome, 'shared');
    claudeDir = join(testHome, '.claude');
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
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

  it('logs would-create-symlink and would-auto-move lines without writing anything under HOME', async () => {
    // shared/CLAUDE.md exists in the repo; ~/.claude/CLAUDE.md is a real file
    // (not a symlink). Real-mode would back up and replace it; dry-run logs the
    // intent only.
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# new\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# old\n');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260516-000000', { projects: {} }, { dryRun: true });

    const joined = logs.join('\n');
    expect(joined).toContain('would auto-move non-symlink:');
    expect(joined).toContain('would create symlink:');

    const linkPath = join(claudeDir, 'CLAUDE.md');
    // Content equality alone proves dry-run left the pre-existing file
    // intact: an auto-move would have replaced it with a symlink whose
    // target (shared/CLAUDE.md) holds different content. Avoiding a
    // separate lstatSync check keeps the assertion off the
    // check-then-use file system pattern CodeQL flags.
    expect(readFileSync(linkPath, 'utf8')).toBe('# old\n');

    const backupRoot = join(testHome, '.cache', 'claude-nomad', 'backup', '20260516-000000');
    expect(existsSync(backupRoot)).toBe(false);
  });

  it('default (no opts) and dryRun:false continue to mutate disk as before', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# new\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# old\n');
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260516-000000', { projects: {} });
    expect(lstatSync(join(claudeDir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
  });

  it('dryRun:false explicit also mutates (no regression vs default)', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# new\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# old\n');
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260516-000000', { projects: {} }, { dryRun: false });
    expect(lstatSync(join(claudeDir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
  });
});

describe('applySharedLinks onPreview structured sink', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let sharedDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-onpreview-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedDir = join(repoUnderHome, 'shared');
    claudeDir = join(testHome, '.claude');
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
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

  it('calls onPreview with create event and does NOT call log() for create', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# new\n');
    // No pre-existing ~/.claude/CLAUDE.md so only create fires, not auto-move.
    const events: unknown[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks(
      'ts1',
      { projects: {} },
      {
        dryRun: true,
        onPreview: (e) => events.push(e),
      },
    );
    const createEvents = events.filter((e) => (e as { kind: string }).kind === 'create');
    expect(createEvents.length).toBeGreaterThan(0);
    // log() must NOT have been called for the create line when onPreview is set.
    const logLines = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logLines).not.toContain('would create symlink:');
  });

  it('calls onPreview with auto-move event and does NOT call log() for auto-move', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# new\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# old\n');
    const events: unknown[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks(
      'ts2',
      { projects: {} },
      {
        dryRun: true,
        onPreview: (e) => events.push(e),
      },
    );
    const moveEvents = events.filter((e) => (e as { kind: string }).kind === 'auto-move');
    expect(moveEvents.length).toBeGreaterThan(0);
    expect((moveEvents[0] as { from: string }).from).toContain('CLAUDE.md');
    expect((moveEvents[0] as { to: string }).to).toContain('backup/ts2/CLAUDE.md');
    const logLines = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logLines).not.toContain('would auto-move non-symlink:');
  });

  it('falls back to log() for create when onPreview is absent', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# new\n');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('ts3', { projects: {} }, { dryRun: true });
    expect(logs.join('\n')).toContain('would create symlink:');
  });

  it('falls back to log() for auto-move when onPreview is absent', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# new\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# old\n');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('ts4', { projects: {} }, { dryRun: true });
    expect(logs.join('\n')).toContain('would auto-move non-symlink:');
  });

  // Test A: already-correct symlink suppresses create event in dry-run.
  it('emits no create event for a name whose link path is already a symlink (clean host)', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
    const sharedTarget = join(sharedDir, 'CLAUDE.md');
    const linkPath = join(claudeDir, 'CLAUDE.md');
    symlinkSync(sharedTarget, linkPath);

    const events: unknown[] = [];
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks(
      'ts-clean',
      { projects: {} },
      { dryRun: true, onPreview: (e) => events.push(e) },
    );

    const creates = events.filter((e) => (e as { kind: string }).kind === 'create');
    const claudeMdCreates = creates.filter((e) =>
      (e as { from: string }).from.endsWith('CLAUDE.md'),
    );
    expect(claudeMdCreates).toHaveLength(0);
  });

  // Test B: missing link still emits a create event.
  it('emits a create event for a name with shared/<name> present but no link on disk', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
    // No ~/.claude/CLAUDE.md created.

    const events: unknown[] = [];
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks(
      'ts-missing',
      { projects: {} },
      { dryRun: true, onPreview: (e) => events.push(e) },
    );

    const creates = events.filter((e) => (e as { kind: string }).kind === 'create');
    const claudeMdCreates = creates.filter((e) =>
      (e as { from: string }).from.endsWith('CLAUDE.md'),
    );
    expect(claudeMdCreates.length).toBeGreaterThan(0);
  });

  // Test C: symlink pointing at a live but wrong target emits NO create event.
  // The guard mirrors ensureSymlink: any existing symlink (existsSync follows
  // it to the live target) is considered already-satisfied. Intentional parity
  // with ensureSymlink, which no-ops on any symlink without comparing targets.
  it('emits no create event for a symlink pointing at a live but wrong target (ensureSymlink parity)', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
    // Create a real file to be the "wrong" live target so existsSync follows
    // the symlink and returns true.
    const wrongTarget = join(testHome, 'some-other-file.md');
    writeFileSync(wrongTarget, '# wrong\n');
    const linkPath = join(claudeDir, 'CLAUDE.md');
    symlinkSync(wrongTarget, linkPath);

    const events: unknown[] = [];
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks(
      'ts-wrongtarget',
      { projects: {} },
      { dryRun: true, onPreview: (e) => events.push(e) },
    );

    const creates = events.filter((e) => (e as { kind: string }).kind === 'create');
    const claudeMdCreates = creates.filter((e) =>
      (e as { from: string }).from.endsWith('CLAUDE.md'),
    );
    expect(claudeMdCreates).toHaveLength(0);
  });

  // Test D: non-symlink occupant still produces both auto-move and create events.
  it('emits both auto-move and create events when a non-symlink occupies the link path', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# real file\n');

    const events: unknown[] = [];
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks(
      'ts-nonlink',
      { projects: {} },
      { dryRun: true, onPreview: (e) => events.push(e) },
    );

    const moves = events.filter((e) => (e as { kind: string }).kind === 'auto-move');
    const creates = events.filter((e) => (e as { kind: string }).kind === 'create');
    expect(moves.length).toBeGreaterThan(0);
    expect(creates.length).toBeGreaterThan(0);
  });
});

describe('applySharedLinks sharedDirs support', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let sharedDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedDir = join(repoUnderHome, 'shared');
    claudeDir = join(testHome, '.claude');
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
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

  it('creates a symlink for a valid sharedDirs entry when shared/<entry> exists', async () => {
    mkdirSync(join(sharedDir, 'gsd'), { recursive: true });
    writeFileSync(join(sharedDir, 'gsd', 'tool.sh'), '#!/bin/sh\n');
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260516-000000', { projects: {}, sharedDirs: ['gsd'] });

    const linkPath = join(claudeDir, 'gsd');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(join(sharedDir, 'gsd'));
  });

  it('backs up a non-symlink at a sharedDirs link path and replaces it with a symlink', async () => {
    mkdirSync(join(sharedDir, 'gsd'), { recursive: true });
    writeFileSync(join(sharedDir, 'gsd', 'tool.sh'), '#!/bin/sh\n');
    mkdirSync(join(claudeDir, 'gsd'), { recursive: true });
    writeFileSync(join(claudeDir, 'gsd', 'local.md'), '# local gsd\n');

    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260516-000000', { projects: {}, sharedDirs: ['gsd'] });

    const backupFile = join(
      testHome,
      '.cache',
      'claude-nomad',
      'backup',
      '20260516-000000',
      'gsd',
      'local.md',
    );
    expect(existsSync(backupFile)).toBe(true);
    expect(readFileSync(backupFile, 'utf8')).toBe('# local gsd\n');

    const linkPath = join(claudeDir, 'gsd');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(join(sharedDir, 'gsd'));
  });

  it('logs would-auto-move for a non-symlink sharedDirs entry under dryRun', async () => {
    mkdirSync(join(sharedDir, 'gsd'), { recursive: true });
    writeFileSync(join(sharedDir, 'gsd', 'tool.sh'), '#!/bin/sh\n');
    mkdirSync(join(claudeDir, 'gsd'), { recursive: true });
    writeFileSync(join(claudeDir, 'gsd', 'local.md'), '# local gsd\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260516-000000', { projects: {}, sharedDirs: ['gsd'] }, { dryRun: true });

    expect(logs.join('\n')).toContain('would auto-move non-symlink:');
    expect(logs.join('\n')).toContain('would create symlink:');
    // Dry-run: original gsd dir must still be intact
    expect(existsSync(join(claudeDir, 'gsd', 'local.md'))).toBe(true);
    expect(lstatSync(join(claudeDir, 'gsd')).isSymbolicLink()).toBe(false);
  });

  it('skips a sharedDirs entry whose shared/<entry> source does not exist', async () => {
    // shared/gsd does NOT exist; ~/.claude/gsd should be left untouched.
    mkdirSync(join(claudeDir, 'gsd'), { recursive: true });
    writeFileSync(join(claudeDir, 'gsd', 'local.md'), '# local gsd\n');
    // Provide at least one SHARED_LINKS source so the function is not a no-op.
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');

    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260516-000000', { projects: {}, sharedDirs: ['gsd'] });

    // ~/.claude/gsd must be unchanged (not backed up, not symlinked)
    expect(lstatSync(join(claudeDir, 'gsd')).isDirectory()).toBe(true);
    expect(lstatSync(join(claudeDir, 'gsd')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(claudeDir, 'gsd', 'local.md'))).toBe(true);
    const backupGsd = join(testHome, '.cache', 'claude-nomad', 'backup', '20260516-000000', 'gsd');
    expect(existsSync(backupGsd)).toBe(false);
    // CLAUDE.md is still symlinked (SHARED_LINKS still work)
    expect(lstatSync(join(claudeDir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
  });

  it('no-sharedDirs path produces same output as pre-phase (no-sharedDirs map)', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
    const { applySharedLinks } = await import('./links.ts');
    // Both no-sharedDirs-key and empty-sharedDirs should behave identically
    applySharedLinks('20260516-000000', { projects: {} });
    expect(lstatSync(join(claudeDir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
  });
});

describe('regenerateSettings dry-run', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let hostsDir: string;
  let sharedDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedDir = join(repoUnderHome, 'shared');
    hostsDir = join(repoUnderHome, 'hosts');
    claudeDir = join(testHome, '.claude');
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(hostsDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
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

  it('leaves settings.json byte-identical and creates no backup when dryRun:true', async () => {
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(join(hostsDir, 'test-host.json'), JSON.stringify({ hooks: {} }) + '\n');
    const priorContent = JSON.stringify({ model: 'opus', old: true }) + '\n';
    writeFileSync(join(claudeDir, 'settings.json'), priorContent);

    const { regenerateSettings } = await import('./links.ts');
    const result = regenerateSettings('20260516-000000', { dryRun: true });

    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).toBe(priorContent);
    const backupRoot = join(testHome, '.cache', 'claude-nomad', 'backup', '20260516-000000');
    expect(existsSync(backupRoot)).toBe(false);
    // The dry-run path still returns the override label so callers have a
    // consistent return shape (the would-write log is unchanged).
    expect(result).toEqual({ label: 'test-host.json' });
  });

  it('default (no opts), dryRun:false, and empty opts all still mutate settings.json', async () => {
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(join(hostsDir, 'test-host.json'), JSON.stringify({ hooks: {} }) + '\n');

    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260516-000000');
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).toBe(
      JSON.stringify({ model: 'sonnet', hooks: {} }, null, 2) + '\n',
    );

    // Overwrite again with explicit dryRun:false and {}.
    writeFileSync(join(claudeDir, 'settings.json'), '{}\n');
    regenerateSettings('20260516-000001', { dryRun: false });
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).toBe(
      JSON.stringify({ model: 'sonnet', hooks: {} }, null, 2) + '\n',
    );

    writeFileSync(join(claudeDir, 'settings.json'), '{}\n');
    regenerateSettings('20260516-000002', {});
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).toBe(
      JSON.stringify({ model: 'sonnet', hooks: {} }, null, 2) + '\n',
    );
  });
});
