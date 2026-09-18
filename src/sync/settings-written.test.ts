import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as utilsFsModule from '../core/utils.fs.ts';

/**
 * Behavior tests for `readWrittenSettingsKeys`/`recordWrittenSettingsKeys`.
 * Mirrors the temp-HOME harness of the `regenerateSettings (integration)`
 * block in `links.test.ts` so `settingsWrittenPath()` resolves into the
 * temp home.
 */
describe('settings-written', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let recordPath: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-written-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    recordPath = join(testHome, '.cache', 'claude-nomad', 'settings-written-test-host.json');
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../core/utils.fs.ts');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('returns null when no record file exists', async () => {
    const { readWrittenSettingsKeys } = await import('./settings-written.ts');
    expect(readWrittenSettingsKeys()).toBeNull();
  });

  it('returns null when the file holds malformed JSON', async () => {
    mkdirSync(join(testHome, '.cache', 'claude-nomad'), { recursive: true });
    writeFileSync(recordPath, '{ not valid json');
    const { readWrittenSettingsKeys } = await import('./settings-written.ts');
    expect(readWrittenSettingsKeys()).toBeNull();
  });

  it('returns null when the file holds a JSON object rather than an array', async () => {
    mkdirSync(join(testHome, '.cache', 'claude-nomad'), { recursive: true });
    writeFileSync(recordPath, JSON.stringify({ model: true }));
    const { readWrittenSettingsKeys } = await import('./settings-written.ts');
    expect(readWrittenSettingsKeys()).toBeNull();
  });

  it('returns null when the array holds a non-string element', async () => {
    mkdirSync(join(testHome, '.cache', 'claude-nomad'), { recursive: true });
    writeFileSync(recordPath, JSON.stringify(['model', 42]));
    const { readWrittenSettingsKeys } = await import('./settings-written.ts');
    expect(readWrittenSettingsKeys()).toBeNull();
  });

  it('round-trips: record then read returns the recorded keys', async () => {
    const { readWrittenSettingsKeys, recordWrittenSettingsKeys } =
      await import('./settings-written.ts');
    recordWrittenSettingsKeys({ model: 'sonnet', theme: 'dark' });
    expect(readWrittenSettingsKeys()).toEqual(['model', 'theme']);
  });

  it('records the top-level keys of the written object', async () => {
    const { recordWrittenSettingsKeys } = await import('./settings-written.ts');
    recordWrittenSettingsKeys({ a: 1, b: 2 });
    expect(JSON.parse(readFileSync(recordPath, 'utf8'))).toEqual(['a', 'b']);
  });

  it('SAFETY, empty hooks block: recording an object carrying hooks: {} records no hooks key', async () => {
    const { recordWrittenSettingsKeys } = await import('./settings-written.ts');
    recordWrittenSettingsKeys({ model: 'sonnet', hooks: {} });
    expect(JSON.parse(readFileSync(recordPath, 'utf8'))).toEqual(['model']);
  });

  it('SAFETY, gsd-only hooks block: recording a gsd-owned hooks entry records no hooks key', async () => {
    const gsdHook = { type: 'command', command: 'node /a/hooks/gsd-context-monitor.js' };
    const { recordWrittenSettingsKeys } = await import('./settings-written.ts');
    recordWrittenSettingsKeys({
      model: 'sonnet',
      hooks: { SessionStart: [{ matcher: '', hooks: [gsdHook] }] },
    });
    expect(JSON.parse(readFileSync(recordPath, 'utf8'))).toEqual(['model']);
  });

  it('keeps hooks when the written object carries a real non-gsd hook entry', async () => {
    const userHook = { type: 'command', command: 'node /a/hooks/my-personal-hook.js' };
    const { recordWrittenSettingsKeys } = await import('./settings-written.ts');
    recordWrittenSettingsKeys({
      model: 'sonnet',
      hooks: { PreToolUse: [{ matcher: '', hooks: [userHook] }] },
    });
    expect(JSON.parse(readFileSync(recordPath, 'utf8'))).toEqual(['model', 'hooks']);
  });

  it('creates ~/.cache/claude-nomad/ when it does not exist yet', async () => {
    expect(existsSync(join(testHome, '.cache'))).toBe(false);
    const { recordWrittenSettingsKeys } = await import('./settings-written.ts');
    recordWrittenSettingsKeys({ model: 'sonnet' });
    expect(existsSync(recordPath)).toBe(true);
  });

  it('SAFETY, failed write: drops the previous record rather than leaving it stale', async () => {
    mkdirSync(join(testHome, '.cache', 'claude-nomad'), { recursive: true });
    writeFileSync(recordPath, JSON.stringify(['model', 'theme']));
    vi.doMock('../core/utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return {
        ...actual,
        writeJsonAtomic: () => {
          throw new Error('ENOSPC: no space left on device');
        },
      };
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { recordWrittenSettingsKeys } = await import('./settings-written.ts');
    recordWrittenSettingsKeys({ model: 'sonnet' });
    expect(existsSync(recordPath)).toBe(false);
  });

  it('warns and does not throw when the atomic write fails', async () => {
    vi.doMock('../core/utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return {
        ...actual,
        writeJsonAtomic: () => {
          throw new Error('ENOSPC: no space left on device');
        },
      };
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { recordWrittenSettingsKeys } = await import('./settings-written.ts');
    expect(() => recordWrittenSettingsKeys({ model: 'sonnet' })).not.toThrow();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('ENOSPC'))).toBe(true);
  });
});
