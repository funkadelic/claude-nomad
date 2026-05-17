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
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'sonnet' }) + '\n');
    writeFileSync(join(hostsDir, 'test-host.json'), JSON.stringify({ hooks: {} }) + '\n');
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260516-000000');
    const written = readFileSync(join(claudeDir, 'settings.json'), 'utf8');
    expect(written).toBe(JSON.stringify({ model: 'sonnet', hooks: {} }, null, 2) + '\n');
  });

  it('leaves no .tmp sibling after a successful atomic write', async () => {
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'sonnet' }) + '\n');
    writeFileSync(join(hostsDir, 'test-host.json'), JSON.stringify({ hooks: {} }) + '\n');
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260516-000000');
    const leftovers = readdirSync(claudeDir).filter((f) => f.startsWith('settings.json.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('snapshots the prior settings.json to ~/.cache/.../backup/<ts>/ before overwrite', async () => {
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'sonnet' }) + '\n');
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

  it('fires stderr WARN when host file is missing AND prior settings has unbased keys', async () => {
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'sonnet' }) + '\n');
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ model: 'opus', statusLine: { type: 'command' } }) + '\n',
    );
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260516-000000');
    const captured = writes.join('');
    expect(captured).toContain('WARN: no hosts/');
    expect(captured).toContain('unbased keys ["statusLine"]');
    expect(existsSync(join(claudeDir, 'settings.json'))).toBe(true);
  });

  it('does NOT fire WARN when host file is missing but prior settings only has base keys', async () => {
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'sonnet' }) + '\n');
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ model: 'opus' }) + '\n');
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('20260516-000000');
    expect(writes.join('')).not.toContain('WARN');
  });
});
