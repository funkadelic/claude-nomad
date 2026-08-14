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
import type * as fsModule from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ALWAYS_NEVER_SYNC, isDeniedName } from './config.ts';
import { copyExtrasFilteredPreservingBy } from './extras-sync.core.ts';
import { stubPlatform } from './test-helpers.platform.ts';

// Posix-only assertions (symlink creation) throughout this file assume the
// process is genuinely running on a non-win32 host. On a real win32 runner,
// applySharedLinks/syncSharedLinksPush take the copy-sync branch for real
// (process.platform is not mocked in these cases), so these tests are
// skipped there; the win32 behavior itself is covered separately by the
// describe blocks that explicitly override process.platform.
const isWin = process.platform === 'win32';

// Wave-0 gap (63-04 Task 1): the win32 copy-sync branch of applySharedLinks
// wires SHARED_LINKS names (which include FILE entries like CLAUDE.md, not
// only directories) through copyExtrasFilteredPreservingBy. No existing test
// exercises that primitive against a single-file source, so this proves it
// works for both a file source and a directory source before applySharedLinks
// depends on it.
describe('copyExtrasFilteredPreservingBy (file-source and directory-source coverage)', () => {
  let testHome: string;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-copyprim-'));
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it('copies a single-file source to a byte-identical destination file (no throw, no no-op)', () => {
    const src = join(testHome, 'src-CLAUDE.md');
    const dst = join(testHome, 'dst-CLAUDE.md');
    writeFileSync(src, '# shared CLAUDE.md content\n');

    copyExtrasFilteredPreservingBy(src, dst, () => false);

    expect(existsSync(dst)).toBe(true);
    expect(lstatSync(dst).isFile()).toBe(true);
    expect(readFileSync(dst, 'utf8')).toBe('# shared CLAUDE.md content\n');
  });

  it('copies a directory source, preserving the tree and excluding a nested ALWAYS_NEVER_SYNC entry', () => {
    const srcDir = join(testHome, 'src-commands');
    const dstDir = join(testHome, 'dst-commands');
    mkdirSync(join(srcDir, 'nested'), { recursive: true });
    writeFileSync(join(srcDir, 'a.md'), '# a\n');
    writeFileSync(join(srcDir, 'nested', 'b.md'), '# b\n');
    writeFileSync(join(srcDir, 'nested', 'settings.local.json'), '{"secret":true}');

    copyExtrasFilteredPreservingBy(srcDir, dstDir, (name) => isDeniedName(ALWAYS_NEVER_SYNC, name));

    expect(readFileSync(join(dstDir, 'a.md'), 'utf8')).toBe('# a\n');
    expect(readFileSync(join(dstDir, 'nested', 'b.md'), 'utf8')).toBe('# b\n');
    expect(existsSync(join(dstDir, 'nested', 'settings.local.json'))).toBe(false);
  });
});

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

  it('writes settings.json with base + host overrides applied (empty hooks stripped)', async () => {
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    // An empty hooks object carries no entries; after stripping it is removed.
    writeFileSync(join(hostsDir, 'test-host.json'), JSON.stringify({ hooks: {} }) + '\n');
    const { regenerateSettings } = await import('./links.ts');
    const result = regenerateSettings('20260516-000000');
    const written = readFileSync(join(claudeDir, 'settings.json'), 'utf8');
    // Empty hooks block is stripped from the written file.
    expect(written).toBe(JSON.stringify({ model: 'sonnet' }, null, 2) + '\n');
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
    // Empty hooks block is stripped from the written file.
    expect(newContent).toEqual({ model: 'sonnet' });
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

  // Valid JSON that is not a plain object (null, an array, a primitive) must
  // degrade to nothing-to-preserve exactly like unparseable content, never
  // crash keepGsdHookEntries/stripGsdHookEntries/classifySettingsDrift.
  it.each([
    ['the JSON literal null', 'null'],
    ['a JSON array', '[]'],
    ['a JSON primitive', '42'],
  ])('regenerates settings when prior settings.json is %s', async (_label, content) => {
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(join(claudeDir, 'settings.json'), content);
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
    // behind-drift: merged has a non-gsd key absent from settings -> pull hint.
    // Use `statusLine` (not hooks) so the strip does not remove the divergent key.
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet', statusLine: { type: 'command' } }) + '\n',
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
    expect(captured).toContain('statusLine');
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
    // (nomad capture-settings) WARNs are emitted. Use `verboseOutput` (a
    // non-hooks key) for the behind case so the strip does not remove it.
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    // Host override with a non-hooks key so the behind-drift WARN still fires.
    writeFileSync(join(hostsDir, 'test-host.json'), JSON.stringify({ verboseOutput: true }) + '\n');
    // merged = { model: 'sonnet', verboseOutput: true }
    // settings has statusLine (ahead) but not verboseOutput (behind).
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
    // behind: verboseOutput is missing from settings -> nomad pull
    expect(captured).toContain('nomad pull');
    expect(captured).toContain('verboseOutput');
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

  it.skipIf(isWin)('never creates a symlink for a credential-shaped sharedDirs entry', async () => {
    // The consumer-level half of the guard: unit tests prove the guard
    // rejects ".env", this proves applySharedLinks does not then materialize
    // ~/.claude/.env, which is the behavior that protects the user.
    mkdirSync(join(sharedDir, '.env'), { recursive: true });
    writeFileSync(join(sharedDir, '.env', 'token'), 'SECRET=1\n');

    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260516-000000', { projects: {}, sharedDirs: ['.env'] });

    expect(existsSync(join(claudeDir, '.env'))).toBe(false);
  });

  it.skipIf(isWin)(
    'backs up a pre-existing real DIR and replaces it with a symlink in one call (commands)',
    async () => {
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
    },
  );

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

  it.skipIf(isWin)(
    'backs up a pre-existing real FILE (CLAUDE.md) and replaces it with a symlink',
    async () => {
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
    },
  );

  it.skipIf(isWin)(
    'leaves pre-existing CORRECT symlinks alone and creates no backup (idempotent)',
    async () => {
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
    },
  );

  it.skipIf(isWin)(
    'leaves local SHARED_LINK content alone when repo has no counterpart',
    async () => {
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
    },
  );

  it.skipIf(isWin)(
    'handles multiple non-symlink conflicts in a single pass (rules + commands)',
    async () => {
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
      expect(readFileSync(join(backupRoot, 'commands', 'baz.md'), 'utf8')).toBe(
        '# local commands\n',
      );
    },
  );
});

describe('applySharedLinks win32 copy branch', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let sharedDir: string;
  const realPlatform = process.platform;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-win32-'));
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
    stubPlatform(realPlatform);
    vi.restoreAllMocks();
    // Later cases in this describe re-import links.ts after resetModules, and
    // restoreAllMocks does not clear a doMock registration, so without this
    // they would get the throwing lstatSync too.
    vi.doUnmock('node:fs');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('materializes a file entry and a directory entry as real copies on win32 (no symlink)', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
    writeFileSync(join(sharedDir, 'commands', 'foo.md'), '# shared command\n');

    stubPlatform('win32');
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260701-000000', { projects: {} });

    const claudeMd = join(claudeDir, 'CLAUDE.md');
    expect(lstatSync(claudeMd).isSymbolicLink()).toBe(false);
    expect(readFileSync(claudeMd, 'utf8')).toBe('# shared\n');

    const commandsDir = join(claudeDir, 'commands');
    expect(lstatSync(commandsDir).isSymbolicLink()).toBe(false);
    expect(lstatSync(commandsDir).isDirectory()).toBe(true);
    expect(readFileSync(join(commandsDir, 'foo.md'), 'utf8')).toBe('# shared command\n');
  });

  it('backs up prior real-copy content before overwriting on win32 (non-symlink destructive path)', async () => {
    // A real (non-symlink) file already occupies the link path -- the normal
    // post-copy state on win32. The overlay must snapshot it via
    // backupBeforeWrite BEFORE copySharedLinkPull overwrites it, so an
    // unpushed local edit is recoverable.
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# new shared content\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# prior real-copy content\n');

    stubPlatform('win32');
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260701-000007', { projects: {} });

    const claudeMd = join(claudeDir, 'CLAUDE.md');
    expect(lstatSync(claudeMd).isSymbolicLink()).toBe(false);
    expect(readFileSync(claudeMd, 'utf8')).toBe('# new shared content\n');

    const backupFile = join(
      testHome,
      '.cache',
      'claude-nomad',
      'backup',
      '20260701-000007',
      'CLAUDE.md',
    );
    expect(existsSync(backupFile)).toBe(true);
    expect(readFileSync(backupFile, 'utf8')).toBe('# prior real-copy content\n');
  });

  it('migrates a symlink-era leftover: backs it up and replaces it with a real copy on win32', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# new\n');
    const linkPath = join(claudeDir, 'CLAUDE.md');
    // Simulate a leftover symlink from before this branch existed (or a host
    // that previously shared ~/.claude with a symlink-capable OS).
    symlinkSync(join(sharedDir, 'CLAUDE.md'), linkPath);

    stubPlatform('win32');
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260701-000001', { projects: {} });

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(linkPath, 'utf8')).toBe('# new\n');

    const backupFile = join(
      testHome,
      '.cache',
      'claude-nomad',
      'backup',
      '20260701-000001',
      'CLAUDE.md',
    );
    expect(existsSync(backupFile)).toBe(true);
  });

  it('skips a name whose repo shared/<name> counterpart is absent, on win32', async () => {
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'local-only.md'), '# local-only\n');
    // At least one other shared link exists so the run is not a no-op.
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');

    stubPlatform('win32');
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260701-000002', { projects: {} });

    expect(existsSync(join(claudeDir, 'commands', 'local-only.md'))).toBe(true);
    expect(readFileSync(join(claudeDir, 'commands', 'local-only.md'), 'utf8')).toBe(
      '# local-only\n',
    );
  });

  it.skipIf(isWin)(
    'does not create a symlink; posix host in the same run still symlinks unchanged',
    async () => {
      // Sanity: on a non-win32 stub the same setup still produces a symlink,
      // proving the win32 branch above is genuinely gated on process.platform
      // and not a global behavior change.
      writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
      const { applySharedLinks } = await import('./links.ts');
      applySharedLinks('20260701-000003', { projects: {} });
      expect(lstatSync(join(claudeDir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    },
  );

  it('dry-run on win32 emits a copy preview event (not create) and does not mutate disk', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
    stubPlatform('win32');
    const events: { kind: string; from: string; to: string }[] = [];
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks(
      '20260701-000004',
      { projects: {} },
      { dryRun: true, onPreview: (e) => events.push(e) },
    );
    expect(existsSync(join(claudeDir, 'CLAUDE.md'))).toBe(false);
    const copyEvents = events.filter((e) => e.kind === 'copy');
    expect(copyEvents.length).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === 'create')).toBe(false);
  });

  it('falls back to log() with "would copy" text for win32 dry-run when onPreview is absent', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
    stubPlatform('win32');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260701-000005', { projects: {} }, { dryRun: true });
    expect(logs.join('\n')).toContain('would copy:');
  });

  it('dry-run/wet-run parity on win32: previewed copy names equal wet-copied names', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
    writeFileSync(join(sharedDir, 'commands', 'foo.md'), '# shared command\n');
    stubPlatform('win32');

    const events: { kind: string; from: string; to: string }[] = [];
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks(
      '20260701-000006',
      { projects: {} },
      { dryRun: true, onPreview: (e) => events.push(e) },
    );
    const previewedNames = events
      .filter((e) => e.kind === 'copy')
      .map((e) => e.from)
      .sort();

    // Fresh module instance for the wet run so no dry-run side effects leak in.
    vi.resetModules();
    const { applySharedLinks: applySharedLinksWet } = await import('./links.ts');
    applySharedLinksWet('20260701-000006', { projects: {} });
    const wetCopiedNames = [join(claudeDir, 'CLAUDE.md'), join(claudeDir, 'commands')]
      .filter((p) => existsSync(p))
      .sort();

    expect(previewedNames).toEqual(wetCopiedNames);
  });

  it('warns and keeps going when a shared name cannot be stat-ed on the host', async () => {
    // Two shared names so the run is not a no-op: CLAUDE.md is the one blocked
    // at the stat site, commands/foo.md sorts after it and must still land.
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
    writeFileSync(join(sharedDir, 'commands', 'foo.md'), '# shared command\n');
    const blocked = join(claudeDir, 'CLAUDE.md');
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        lstatSync: (p: fsModule.PathLike, opts?: fsModule.StatSyncOptions) => {
          if (String(p) === blocked) throw new Error('EPERM: operation not permitted');
          return actual.lstatSync(p, opts);
        },
      };
    });
    stubPlatform('win32');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });

    const { applySharedLinks } = await import('./links.ts');
    expect(() => applySharedLinks('20260813-000000', { projects: {} })).not.toThrow();

    const said = errSpy.mock.calls.map((c) => String(c[0]));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(blocked);
    expect(said[0]).toContain('could not be updated');
    expect(said[0]).toContain('EPERM');
    expect(said[0]).toContain('it keeps the copy it had before this pull');
    expect(said[0]).toContain('The rest of the pull continues');
    expect(said[0]).toContain('another program has it open');
    expect(said[0]).toContain("run 'nomad pull' again to update it");
    // The WARN fires mid-loop, before the rest of the list has been touched,
    // so a completed-tense claim about the other names would be false
    // whenever the failing name sorts early; the reassurance must stay
    // forward-looking instead.
    expect(said[0]).not.toContain('were updated');
    expect(existsSync(blocked)).toBe(false);
    expect(readFileSync(join(claudeDir, 'commands', 'foo.md'), 'utf8')).toBe('# shared command\n');
  });

  it('warns and keeps going when the copy step itself throws for a shared name', async () => {
    // No pre-existing host copy of CLAUDE.md, so the outer lstatSync in
    // applySharedLinksWin32 returns undefined and the fault is injected
    // further down, inside copySharedLinkPull's own cpSync call. This proves
    // the guard's try spans the whole write half of the loop, not just the
    // leading stat: narrowing the try back to lstatSync alone must turn this
    // test red.
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
    writeFileSync(join(sharedDir, 'commands', 'foo.md'), '# shared command\n');
    const blockedDst = join(claudeDir, 'CLAUDE.md');
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        cpSync: (src: string | URL, dst: string | URL, opts?: fsModule.CopySyncOptions) => {
          if (String(dst) === blockedDst) throw new Error('EBUSY: resource busy or locked');
          return actual.cpSync(src, dst, opts);
        },
      };
    });
    stubPlatform('win32');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });

    const { applySharedLinks } = await import('./links.ts');
    expect(() => applySharedLinks('20260813-000001', { projects: {} })).not.toThrow();

    const said = errSpy.mock.calls.map((c) => String(c[0]));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(blockedDst);
    expect(said[0]).toContain('could not be updated');
    expect(said[0]).toContain('EBUSY');
    expect(said[0]).toContain('it keeps the copy it had before this pull');
    expect(said[0]).toContain('The rest of the pull continues');
    expect(said[0]).toContain('another program has it open');
    expect(said[0]).toContain("run 'nomad pull' again to update it");
    expect(said[0]).not.toContain('were updated');
    expect(existsSync(blockedDst)).toBe(false);
    expect(readFileSync(join(claudeDir, 'commands', 'foo.md'), 'utf8')).toBe('# shared command\n');
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

  it.skipIf(isWin)(
    'logs would-create-symlink and would-auto-move lines without writing anything under HOME',
    async () => {
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
    },
  );

  it.skipIf(isWin)(
    'default (no opts) and dryRun:false continue to mutate disk as before',
    async () => {
      writeFileSync(join(sharedDir, 'CLAUDE.md'), '# new\n');
      writeFileSync(join(claudeDir, 'CLAUDE.md'), '# old\n');
      const { applySharedLinks } = await import('./links.ts');
      applySharedLinks('20260516-000000', { projects: {} });
      expect(lstatSync(join(claudeDir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    },
  );

  it.skipIf(isWin)('dryRun:false explicit also mutates (no regression vs default)', async () => {
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

  it.skipIf(isWin)(
    'calls onPreview with create event and does NOT call log() for create',
    async () => {
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
    },
  );

  it.skipIf(isWin)(
    'calls onPreview with auto-move event and does NOT call log() for auto-move',
    async () => {
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
    },
  );

  it.skipIf(isWin)('falls back to log() for create when onPreview is absent', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# new\n');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('ts3', { projects: {} }, { dryRun: true });
    expect(logs.join('\n')).toContain('would create symlink:');
  });

  it.skipIf(isWin)('falls back to log() for auto-move when onPreview is absent', async () => {
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
  it.skipIf(isWin)(
    'emits a create event for a name with shared/<name> present but no link on disk',
    async () => {
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
    },
  );

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
  it.skipIf(isWin)(
    'emits both auto-move and create events when a non-symlink occupies the link path',
    async () => {
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
    },
  );
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

  it.skipIf(isWin)(
    'creates a symlink for a valid sharedDirs entry when shared/<entry> exists',
    async () => {
      mkdirSync(join(sharedDir, 'gsd'), { recursive: true });
      writeFileSync(join(sharedDir, 'gsd', 'tool.sh'), '#!/bin/sh\n');
      const { applySharedLinks } = await import('./links.ts');
      applySharedLinks('20260516-000000', { projects: {}, sharedDirs: ['gsd'] });

      const linkPath = join(claudeDir, 'gsd');
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linkPath)).toBe(join(sharedDir, 'gsd'));
    },
  );

  it.skipIf(isWin)(
    'backs up a non-symlink at a sharedDirs link path and replaces it with a symlink',
    async () => {
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
    },
  );

  it.skipIf(isWin)(
    'logs would-auto-move for a non-symlink sharedDirs entry under dryRun',
    async () => {
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
    },
  );

  it.skipIf(isWin)(
    'skips a sharedDirs entry whose shared/<entry> source does not exist',
    async () => {
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
      const backupGsd = join(
        testHome,
        '.cache',
        'claude-nomad',
        'backup',
        '20260516-000000',
        'gsd',
      );
      expect(existsSync(backupGsd)).toBe(false);
      // CLAUDE.md is still symlinked (SHARED_LINKS still work)
      expect(lstatSync(join(claudeDir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    },
  );

  it.skipIf(isWin)(
    'no-sharedDirs path produces same output as pre-phase (no-sharedDirs map)',
    async () => {
      writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
      const { applySharedLinks } = await import('./links.ts');
      // Both no-sharedDirs-key and empty-sharedDirs should behave identically
      applySharedLinks('20260516-000000', { projects: {} });
      expect(lstatSync(join(claudeDir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    },
  );

  it.skipIf(isWin)(
    'omitting opts.linkNames derives allSharedLinks(map) internally, WARNing once for an invalid entry',
    async () => {
      writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
        /* captured */
      });
      const { applySharedLinks } = await import('./links.ts');
      applySharedLinks('20260516-000000', { projects: {}, sharedDirs: ['../escape'] });
      const rejectionCalls = errSpy.mock.calls.filter((c) =>
        String(c[0]).includes('sharedDirs entry'),
      );
      expect(rejectionCalls).toHaveLength(1);
      // The rejection must not cost the valid names their link: the derived
      // list is the built-in set plus whatever survived validation.
      expect(lstatSync(join(claudeDir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    },
  );

  it.skipIf(isWin)(
    'opts.quietNames silences the rejection WARN while still linking every valid name from the map it was handed',
    async () => {
      writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
      mkdirSync(join(sharedDir, 'gsd'), { recursive: true });
      writeFileSync(join(sharedDir, 'gsd', 'tool.sh'), '#!/bin/sh\n');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
        /* captured */
      });
      const { applySharedLinks } = await import('./links.ts');
      // quietNames says only "a caller already reported this map's rejected
      // entries"; the name list itself still comes from this map, so both the
      // static entry and the valid sharedDirs entry are materialized.
      applySharedLinks(
        '20260516-000000',
        { projects: {}, sharedDirs: ['gsd', '../escape'] },
        { quietNames: true },
      );
      expect(errSpy).not.toHaveBeenCalled();
      expect(lstatSync(join(claudeDir, 'gsd')).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(claudeDir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    },
  );
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
    // Empty hooks object is stripped on write; use a non-hooks key to verify
    // the host override is applied.
    writeFileSync(join(hostsDir, 'test-host.json'), JSON.stringify({ verboseOutput: true }) + '\n');

    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260516-000000');
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).toBe(
      JSON.stringify({ model: 'sonnet', verboseOutput: true }, null, 2) + '\n',
    );

    // Overwrite again with explicit dryRun:false and {}.
    writeFileSync(join(claudeDir, 'settings.json'), '{}\n');
    regenerateSettings('20260516-000001', { dryRun: false });
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).toBe(
      JSON.stringify({ model: 'sonnet', verboseOutput: true }, null, 2) + '\n',
    );

    writeFileSync(join(claudeDir, 'settings.json'), '{}\n');
    regenerateSettings('20260516-000002', {});
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).toBe(
      JSON.stringify({ model: 'sonnet', verboseOutput: true }, null, 2) + '\n',
    );
  });
});

// ---------------------------------------------------------------------------
// gsd hook entry filtering in regenerateSettings
// ---------------------------------------------------------------------------

/** A gsd-owned hook entry (command has gsd- script basename). */
const gsdEntry = { type: 'command', command: 'node /a/hooks/gsd-context-monitor.js' };
/** A second distinct gsd entry. */
const gsdEntry2 = { type: 'command', command: 'node /a/hooks/gsd-workflow-guard.js' };
/** A user-authored hook entry (no gsd- script basename). */
const userEntry = { type: 'command', command: 'node /a/hooks/my-personal-hook.js' };

describe('regenerateSettings gsd-hook filtering', () => {
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
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-hook-filter-'));
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

  it('Test 1: base has gsd hooks + user hook -> written file retains only the user hook', async () => {
    const base = {
      model: 'sonnet',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [gsdEntry, gsdEntry2, userEntry] }],
      },
    };
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify(base) + '\n');
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260101-000000');
    const written = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const hooksBlock = written.hooks as Record<string, unknown>;
    const matchers = hooksBlock.PreToolUse as unknown[];
    const inner = (matchers[0] as Record<string, unknown>).hooks as unknown[];
    expect(inner).toHaveLength(1);
    expect((inner[0] as Record<string, unknown>).command).toBe('node /a/hooks/my-personal-hook.js');
  });

  it('Test 2: base has only gsd-owned hooks -> written file has no hooks key', async () => {
    const base = {
      model: 'sonnet',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [gsdEntry, gsdEntry2] }],
      },
    };
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify(base) + '\n');
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260101-000000');
    const written = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(written).not.toHaveProperty('hooks');
  });

  it('Test 3: host override has a gsd hook -> merged result is still filtered (runs on merged)', async () => {
    // Base has no hooks; the gsd hook comes in via the host override.
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(
      join(hostsDir, 'test-host.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [gsdEntry] }] },
      }) + '\n',
    );
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260101-000000');
    const written = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(written).not.toHaveProperty('hooks');
  });

  it('Test 4: gsd-only divergence between base and live settings does NOT fire a spurious WARN', async () => {
    // Base has only gsd hooks; live settings has different gsd hooks.
    // After stripping both sides the hooks key is absent everywhere -> no drift.
    const base = {
      model: 'sonnet',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [gsdEntry] }],
      },
    };
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify(base) + '\n');
    // Live settings has a DIFFERENT gsd hook set (as gsd self-heals).
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        model: 'sonnet',
        hooks: { Stop: [{ matcher: '', hooks: [gsdEntry2] }] },
      }) + '\n',
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
    regenerateSettings('20260101-000000');
    // No WARN should fire for the hooks divergence.
    expect(writes.join('')).not.toContain('⚠︎');
  });

  it('Test 4b: genuine user hook in live settings still triggers the ahead-WARN', async () => {
    // Base has no hooks; live settings has a user-authored hook -> ahead drift.
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    // Host file exists so the ahead-WARN is emitted (gates on hostFileExists).
    writeFileSync(join(hostsDir, 'test-host.json'), JSON.stringify({}) + '\n');
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        model: 'sonnet',
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [userEntry] }] },
      }) + '\n',
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
    regenerateSettings('20260101-000000');
    const captured = writes.join('');
    // The genuine user hook is ahead-only -> nomad capture-settings WARN.
    expect(captured).toContain('nomad capture-settings');
    expect(captured).toContain('hooks');
  });
});

// ---------------------------------------------------------------------------
// gsd-owned hook entry PRESERVATION in regenerateSettings (Phase 64)
// ---------------------------------------------------------------------------

/** A gsd SessionStart hook (the check-update hook gsd self-heals each session). */
const gsdCheckUpdate = { type: 'command', command: 'node /a/hooks/gsd-check-update.js' };

describe('regenerateSettings gsd-hook preservation', () => {
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
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-hook-preserve-'));
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

  it('retains a live gsd-check-update.js SessionStart hook across a wet regenerate', async () => {
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    // The live file carries a gsd hook (as gsd self-heals it) that base lacks.
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        model: 'sonnet',
        hooks: { SessionStart: [{ matcher: '', hooks: [gsdCheckUpdate] }] },
      }) + '\n',
    );
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260101-000000');
    const written = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const event = (written.hooks as Record<string, unknown>).SessionStart as unknown[];
    expect(event).toHaveLength(1);
    const inner = (event[0] as Record<string, unknown>).hooks as unknown[];
    expect((inner[0] as Record<string, unknown>).command).toBe('node /a/hooks/gsd-check-update.js');
  });

  it('clean path (live file has no gsd hooks) is byte-identical to the pre-change write', async () => {
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(join(hostsDir, 'test-host.json'), JSON.stringify({ hooks: {} }) + '\n');
    // Live file has only a user-authored prior state, no gsd hooks.
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ model: 'opus' }) + '\n');
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260101-000000');
    // Exact serialized string: identical to the empty-hooks-stripped baseline.
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).toBe(
      JSON.stringify({ model: 'sonnet' }, null, 2) + '\n',
    );
  });

  it('a user hook (from base) and a preserved gsd hook coexist under a shared event key', async () => {
    // Base contributes a USER hook under SessionStart; the live file contributes
    // a gsd hook under the SAME event key. Both must survive the regenerate.
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({
        model: 'sonnet',
        hooks: { SessionStart: [{ matcher: 'user', hooks: [userEntry] }] },
      }) + '\n',
    );
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        model: 'sonnet',
        hooks: { SessionStart: [{ matcher: 'gsd', hooks: [gsdCheckUpdate] }] },
      }) + '\n',
    );
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260101-000000');
    const written = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const event = (written.hooks as Record<string, unknown>).SessionStart as unknown[];
    expect(event).toHaveLength(2);
    const matchers = event.map((e) => (e as Record<string, unknown>).matcher);
    expect(matchers).toContain('user');
    expect(matchers).toContain('gsd');
  });

  it('a malformed live settings.json degrades to no-preserve without throwing', async () => {
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
    expect(() => regenerateSettings('20260101-000000')).not.toThrow();
    // The malformed WARN still fires and the file is overwritten from base only.
    expect(writes.join('')).toContain('⚠︎ existing settings.json is malformed');
    expect(JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'))).toEqual({
      model: 'sonnet',
    });
  });

  it('dry-run does not preserve or write (live gsd hook file left byte-identical)', async () => {
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    const priorContent =
      JSON.stringify({
        model: 'opus',
        hooks: { SessionStart: [{ matcher: '', hooks: [gsdCheckUpdate] }] },
      }) + '\n';
    writeFileSync(join(claudeDir, 'settings.json'), priorContent);
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260101-000000', { dryRun: true });
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).toBe(priorContent);
  });
});
