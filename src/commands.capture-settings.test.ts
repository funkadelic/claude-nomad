import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Test environment helpers
// ---------------------------------------------------------------------------

/** Minimal test environment for capture-settings tests. */
type CaptureEnv = {
  testHome: string;
  repoDir: string;
  sharedDir: string;
  hostsDir: string;
  claudeDir: string;
  settingsPath: string;
  basePath: string;
};

/**
 * Set up a temporary HOME with the standard nomad directory layout.
 *
 * @param opts.host - NOMAD_HOST value (default: 'test-host').
 * @returns Configured test environment.
 */
function makeCaptureEnv(opts: { host?: string } = {}): CaptureEnv {
  const host = opts.host ?? 'test-host';
  const testHome = mkdtempSync(join(tmpdir(), 'nomad-cap-'));
  process.env.HOME = testHome;
  process.env.NOMAD_HOST = host;

  const repoDir = join(testHome, 'claude-nomad');
  const sharedDir = join(repoDir, 'shared');
  const hostsDir = join(repoDir, 'hosts');
  const claudeDir = join(testHome, '.claude');

  mkdirSync(sharedDir, { recursive: true });
  mkdirSync(hostsDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });

  const settingsPath = join(claudeDir, 'settings.json');
  const basePath = join(sharedDir, 'settings.base.json');

  return { testHome, repoDir, sharedDir, hostsDir, claudeDir, settingsPath, basePath };
}

// ---------------------------------------------------------------------------
// cmdCaptureSettings tests
// ---------------------------------------------------------------------------

describe('cmdCaptureSettings', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let env: CaptureEnv;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    delete process.env.NOMAD_REPO;
    env = makeCaptureEnv({ host: 'test-host' });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // restoreAllMocks does not clear vi.doMock module mocks; unmock explicitly.
    vi.doUnmock('./utils.lockfile.ts');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(env.testHome, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Happy path: base destination
  // -------------------------------------------------------------------------

  it('promotes ahead-only key into shared/settings.base.json and regenerates settings', async () => {
    writeFileSync(env.basePath, JSON.stringify({ model: 'sonnet' }) + '\n');
    writeFileSync(env.settingsPath, JSON.stringify({ model: 'sonnet', myKey: 'myVal' }) + '\n');

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await cmdCaptureSettings({ host: false, dryRun: false, yes: true });

    const base = JSON.parse(readFileSync(env.basePath, 'utf8')) as Record<string, unknown>;
    expect(base.myKey).toBe('myVal');
    // Regenerated settings should still match
    const settings = JSON.parse(readFileSync(env.settingsPath, 'utf8')) as Record<string, unknown>;
    expect(settings.model).toBe('sonnet');
    expect(settings.myKey).toBe('myVal');
  });

  it('is idempotent: a second run with no new local-only keys logs nothing-to-capture', async () => {
    writeFileSync(env.basePath, JSON.stringify({ model: 'sonnet', myKey: 'myVal' }) + '\n');
    writeFileSync(env.settingsPath, JSON.stringify({ model: 'sonnet', myKey: 'myVal' }) + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await cmdCaptureSettings({ host: false, dryRun: false, yes: true });

    expect(logs.join('\n')).toContain('nothing to capture');
  });

  // -------------------------------------------------------------------------
  // Happy path: host destination
  // -------------------------------------------------------------------------

  it('promotes ahead-only key into hosts/<HOST>.json when --host is set', async () => {
    writeFileSync(env.basePath, JSON.stringify({ model: 'sonnet' }) + '\n');
    writeFileSync(env.settingsPath, JSON.stringify({ model: 'sonnet', hostKey: 'hostVal' }) + '\n');

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await cmdCaptureSettings({ host: true, dryRun: false, yes: true });

    const hostPath = join(env.hostsDir, 'test-host.json');
    expect(existsSync(hostPath)).toBe(true);
    const hostFile = JSON.parse(readFileSync(hostPath, 'utf8')) as Record<string, unknown>;
    expect(hostFile.hostKey).toBe('hostVal');
  });

  it('creates hosts/<HOST>.json when absent and --host is set', async () => {
    writeFileSync(env.basePath, JSON.stringify({ model: 'sonnet' }) + '\n');
    writeFileSync(env.settingsPath, JSON.stringify({ model: 'sonnet', newKey: 'newVal' }) + '\n');

    const hostPath = join(env.hostsDir, 'test-host.json');
    expect(existsSync(hostPath)).toBe(false);

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await cmdCaptureSettings({ host: true, dryRun: false, yes: true });

    expect(existsSync(hostPath)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Node path normalization
  // -------------------------------------------------------------------------

  it('normalizes absolute bin/node paths in captured values when targeting base', async () => {
    writeFileSync(env.basePath, JSON.stringify({ model: 'sonnet' }) + '\n');
    writeFileSync(
      env.settingsPath,
      JSON.stringify({
        model: 'sonnet',
        hooks: { PreToolUse: [{ command: '/home/user/.nvm/versions/node/v22/bin/node' }] },
      }) + '\n',
    );

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await cmdCaptureSettings({ host: false, dryRun: false, yes: true });

    const base = JSON.parse(readFileSync(env.basePath, 'utf8')) as Record<string, unknown>;
    const hooks = base.hooks as { PreToolUse: [{ command: string }] };
    expect(hooks.PreToolUse[0].command).toBe('node');
  });

  it('does NOT normalize absolute bin/node paths when targeting host', async () => {
    writeFileSync(env.basePath, JSON.stringify({ model: 'sonnet' }) + '\n');
    const nodePath = '/home/user/.nvm/versions/node/v22/bin/node';
    writeFileSync(
      env.settingsPath,
      JSON.stringify({
        model: 'sonnet',
        hooks: { PreToolUse: [{ command: nodePath }] },
      }) + '\n',
    );

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await cmdCaptureSettings({ host: true, dryRun: false, yes: true });

    const hostPath = join(env.hostsDir, 'test-host.json');
    const hostFile = JSON.parse(readFileSync(hostPath, 'utf8')) as Record<string, unknown>;
    const hooks = hostFile.hooks as { PreToolUse: [{ command: string }] };
    expect(hooks.PreToolUse[0].command).toBe(nodePath);
  });

  // -------------------------------------------------------------------------
  // Backup
  // -------------------------------------------------------------------------

  it('creates a backup snapshot of the repo source file before writing', async () => {
    writeFileSync(env.basePath, JSON.stringify({ model: 'sonnet' }) + '\n');
    writeFileSync(env.settingsPath, JSON.stringify({ model: 'sonnet', myKey: 'v' }) + '\n');

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await cmdCaptureSettings({ host: false, dryRun: false, yes: true });

    const backupRoot = join(env.testHome, '.cache', 'claude-nomad', 'backup');
    const entries = existsSync(backupRoot) ? (await import('node:fs')).readdirSync(backupRoot) : [];
    // At least one backup timestamp directory should exist
    expect(entries.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Dry-run
  // -------------------------------------------------------------------------

  it('dry-run: logs destination and keys without mutating any file', async () => {
    const originalContent = JSON.stringify({ model: 'sonnet' }) + '\n';
    writeFileSync(env.basePath, originalContent);
    writeFileSync(env.settingsPath, JSON.stringify({ model: 'sonnet', dryKey: 'val' }) + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await cmdCaptureSettings({ host: false, dryRun: true });

    // Base file must be unchanged
    expect(readFileSync(env.basePath, 'utf8')).toBe(originalContent);
    // Log must mention destination and key
    const out = logs.join('\n');
    expect(out).toContain('dry-run');
    expect(out).toContain('dryKey');
    expect(out).toContain('shared/settings.base.json');
  });

  it('dry-run: mentions hosts/<HOST>.json destination when --host is set', async () => {
    writeFileSync(env.basePath, JSON.stringify({ model: 'sonnet' }) + '\n');
    writeFileSync(env.settingsPath, JSON.stringify({ model: 'sonnet', dryKey: 'val' }) + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await cmdCaptureSettings({ host: true, dryRun: true });

    const out = logs.join('\n');
    expect(out).toContain('dry-run');
    expect(out).toContain('hosts/test-host.json');
  });

  // -------------------------------------------------------------------------
  // Edge cases: absent files
  // -------------------------------------------------------------------------

  it('logs nothing-to-capture and returns when settings.json is absent', async () => {
    writeFileSync(env.basePath, JSON.stringify({ model: 'sonnet' }) + '\n');
    // No settingsPath written

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await cmdCaptureSettings({ host: false, dryRun: false, yes: true });

    expect(logs.join('\n')).toContain('nothing to capture');
  });

  it('dies with init-hint when shared/settings.base.json is absent', async () => {
    writeFileSync(env.settingsPath, JSON.stringify({ model: 'sonnet' }) + '\n');
    // No basePath written

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await expect(cmdCaptureSettings({ host: false, dryRun: false })).rejects.toThrow(
      "repo not initialized; run 'nomad init' to scaffold",
    );
  });

  // -------------------------------------------------------------------------
  // Excluded keys are not captured
  // -------------------------------------------------------------------------

  it('does not capture CAPTURE_EXCLUDED_KEYS into base (secret guard)', async () => {
    writeFileSync(env.basePath, JSON.stringify({ model: 'sonnet' }) + '\n');
    writeFileSync(
      env.settingsPath,
      JSON.stringify({
        model: 'sonnet',
        apiKeyHelper: '/home/me/bin/get-key.sh',
        env: { ANTHROPIC_API_KEY: 'sk-secret' },
        myKey: 'safe',
      }) + '\n',
    );

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await cmdCaptureSettings({ host: false, dryRun: false, yes: true });

    const base = JSON.parse(readFileSync(env.basePath, 'utf8')) as Record<string, unknown>;
    expect(Object.hasOwn(base, 'apiKeyHelper')).toBe(false);
    expect(Object.hasOwn(base, 'env')).toBe(false);
    expect(base.myKey).toBe('safe');
  });

  it('does not re-advise capture-settings after a capture when only excluded keys remain ahead', async () => {
    writeFileSync(env.basePath, JSON.stringify({ model: 'sonnet' }) + '\n');
    // myKey is capturable; env stays ahead (excluded) and must not trigger a
    // contradictory "run nomad capture-settings" WARN from the post-capture resync.
    writeFileSync(
      env.settingsPath,
      JSON.stringify({ model: 'sonnet', myKey: 'safe', env: { ANTHROPIC_API_KEY: 'sk-secret' } }) +
        '\n',
    );
    const writes: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      writes.push(args.map(String).join(' ') + '\n');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await cmdCaptureSettings({ host: false, dryRun: false, yes: true });

    const captured = writes.join('');
    expect(captured).not.toContain('nomad capture-settings');
    const base = JSON.parse(readFileSync(env.basePath, 'utf8')) as Record<string, unknown>;
    expect(base.myKey).toBe('safe');
    expect(Object.hasOwn(base, 'env')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Merging into existing destination
  // -------------------------------------------------------------------------

  it('deep-merges new keys into existing base without clobbering existing base keys', async () => {
    writeFileSync(env.basePath, JSON.stringify({ model: 'sonnet', existingKey: 'keep' }) + '\n');
    writeFileSync(
      env.settingsPath,
      JSON.stringify({ model: 'sonnet', existingKey: 'keep', newKey: 'newVal' }) + '\n',
    );

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await cmdCaptureSettings({ host: false, dryRun: false, yes: true });

    const base = JSON.parse(readFileSync(env.basePath, 'utf8')) as Record<string, unknown>;
    expect(base.model).toBe('sonnet');
    expect(base.existingKey).toBe('keep');
    expect(base.newKey).toBe('newVal');
  });

  it('merges into existing host file without clobbering existing host keys', async () => {
    writeFileSync(env.basePath, JSON.stringify({ model: 'sonnet' }) + '\n');
    const hostPath = join(env.hostsDir, 'test-host.json');
    writeFileSync(hostPath, JSON.stringify({ existingHostKey: 'hostVal' }) + '\n');
    writeFileSync(
      env.settingsPath,
      JSON.stringify({ model: 'sonnet', existingHostKey: 'hostVal', newHostKey: 'new' }) + '\n',
    );

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await cmdCaptureSettings({ host: true, dryRun: false, yes: true });

    const hostFile = JSON.parse(readFileSync(hostPath, 'utf8')) as Record<string, unknown>;
    expect(hostFile.existingHostKey).toBe('hostVal');
    expect(hostFile.newHostKey).toBe('new');
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  it('dies when the repo directory does not exist', async () => {
    // Point NOMAD_REPO at a non-existent path
    process.env.NOMAD_REPO = join(env.testHome, 'no-such-repo');
    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await expect(cmdCaptureSettings({ host: false, dryRun: false })).rejects.toThrow();
  });

  it('exits 0 when lock cannot be acquired (contention skip)', async () => {
    writeFileSync(env.basePath, JSON.stringify({ model: 'sonnet' }) + '\n');
    writeFileSync(env.settingsPath, JSON.stringify({ model: 'sonnet', k: 'v' }) + '\n');

    // Simulate lock contention by making acquireLock return null
    vi.doMock('./utils.lockfile.ts', () => ({
      acquireLock: () => null,
      releaseLock: () => undefined,
    }));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit called');
    });

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await expect(cmdCaptureSettings({ host: false, dryRun: false })).rejects.toThrow(
      'process.exit called',
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  // -------------------------------------------------------------------------
  // Confirmation prompt
  // -------------------------------------------------------------------------

  it('writes when the confirmation seam approves, passing the destination and sorted keys', async () => {
    writeFileSync(env.basePath, JSON.stringify({ model: 'sonnet' }) + '\n');
    writeFileSync(
      env.settingsPath,
      JSON.stringify({ model: 'sonnet', bKey: '2', aKey: '1' }) + '\n',
    );

    let seen: { dest: string; keys: string[] } | null = null;
    const confirm = (dest: string, keys: string[]): Promise<boolean> => {
      seen = { dest, keys };
      return Promise.resolve(true);
    };

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await cmdCaptureSettings({ host: false, dryRun: false, confirm });

    expect(seen).toEqual({ dest: 'shared/settings.base.json', keys: ['aKey', 'bKey'] });
    const baseFile = JSON.parse(readFileSync(env.basePath, 'utf8')) as Record<string, unknown>;
    expect(baseFile.aKey).toBe('1');
    expect(baseFile.bKey).toBe('2');
  });

  it('aborts without writing when the confirmation seam declines', async () => {
    const originalContent = JSON.stringify({ model: 'sonnet' }) + '\n';
    writeFileSync(env.basePath, originalContent);
    writeFileSync(env.settingsPath, JSON.stringify({ model: 'sonnet', myKey: 'v' }) + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await cmdCaptureSettings({ host: false, dryRun: false, confirm: () => Promise.resolve(false) });

    expect(readFileSync(env.basePath, 'utf8')).toBe(originalContent);
    expect(logs.join('\n')).toContain('capture aborted');
  });

  it('refuses to write without --yes in a non-interactive shell (default confirm)', async () => {
    const originalContent = JSON.stringify({ model: 'sonnet' }) + '\n';
    writeFileSync(env.basePath, originalContent);
    writeFileSync(env.settingsPath, JSON.stringify({ model: 'sonnet', myKey: 'v' }) + '\n');

    // No confirm seam injected and no --yes: the default TTY-guarded confirm runs.
    // The vitest process is non-interactive, so it must refuse and write nothing.
    const { cmdCaptureSettings } = await import('./commands.capture-settings.ts');
    await cmdCaptureSettings({ host: false, dryRun: false });

    expect(readFileSync(env.basePath, 'utf8')).toBe(originalContent);
  });
});
