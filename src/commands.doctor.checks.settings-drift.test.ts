import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { infoGlyph, okGlyph, warnGlyph } from './color.ts';
import { type Env, makeDoctorEnv, restoreEnv } from './commands.doctor.checks.test-helpers.ts';
import { diffMergedSettings } from './commands.doctor.checks.settings-drift.ts';

// ---------------------------------------------------------------------------
// Pure comparator tests (no filesystem)
// ---------------------------------------------------------------------------

describe('diffMergedSettings', () => {
  it('reports missing key when merged has a key absent from settings', () => {
    const result = diffMergedSettings({ a: 1, b: 2 }, { a: 1 });
    expect(result.missing).toEqual(['b']);
    expect(result.changed).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it('reports changed key when merged and settings share a key with different values', () => {
    const result = diffMergedSettings({ a: 1 }, { a: 2 });
    expect(result.missing).toEqual([]);
    expect(result.changed).toEqual(['a']);
    expect(result.extra).toEqual([]);
  });

  it('reports extra key when settings has a key absent from merged', () => {
    const result = diffMergedSettings({ a: 1 }, { a: 1, z: 9 });
    expect(result.missing).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.extra).toEqual(['z']);
  });

  it('returns all-empty for two empty objects (clean)', () => {
    const result = diffMergedSettings({}, {});
    expect(result.missing).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it('is clean for identical nested objects', () => {
    const result = diffMergedSettings({ h: { x: 1 } }, { h: { x: 1 } });
    expect(result.missing).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it('reports changed for nested objects with different values', () => {
    const result = diffMergedSettings({ h: { x: 1 } }, { h: { x: 2 } });
    expect(result.missing).toEqual([]);
    expect(result.changed).toEqual(['h']);
    expect(result.extra).toEqual([]);
  });

  it('is clean for identical arrays', () => {
    const result = diffMergedSettings({ a: [1, 2] }, { a: [1, 2] });
    expect(result.missing).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it('reports changed for arrays with different element order', () => {
    const result = diffMergedSettings({ a: [1, 2] }, { a: [2, 1] });
    expect(result.missing).toEqual([]);
    expect(result.changed).toEqual(['a']);
    expect(result.extra).toEqual([]);
  });

  it('is clean when both sides have null for the same key', () => {
    const result = diffMergedSettings({ a: null }, { a: null });
    expect(result.missing).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it('reports changed when merged has null and settings has a non-null value', () => {
    const result = diffMergedSettings({ a: null }, { a: 1 });
    expect(result.missing).toEqual([]);
    expect(result.changed).toEqual(['a']);
    expect(result.extra).toEqual([]);
  });

  it('reports changed when merged has a value and settings has null', () => {
    const result = diffMergedSettings({ a: 1 }, { a: null });
    expect(result.missing).toEqual([]);
    expect(result.changed).toEqual(['a']);
    expect(result.extra).toEqual([]);
  });

  it('reproduces the motivating incident: merged has model/hooks/statusLine/enabledPlugins, settings has only two notif keys', () => {
    const merged = {
      model: 'claude-sonnet',
      hooks: { PostToolUse: [] },
      statusLine: 'on',
      enabledPlugins: ['plugin-a'],
    };
    const settings = {
      agentPushNotifEnabled: true,
      inputNeededNotifEnabled: false,
    };
    const result = diffMergedSettings(merged, settings);
    // missing: all four merged keys, sorted
    expect(result.missing).toEqual(['enabledPlugins', 'hooks', 'model', 'statusLine']);
    // extra: the two notif keys, sorted
    expect(result.extra).toEqual(['agentPushNotifEnabled', 'inputNeededNotifEnabled']);
    expect(result.changed).toEqual([]);
  });

  it('sorts output arrays with localeCompare(en) for stable output', () => {
    const result = diffMergedSettings({ z: 1, a: 2, m: 3 }, {});
    expect(result.missing).toEqual(['a', 'm', 'z']);
  });

  it('returns changed (not missing+extra) for a key present on both sides with different values', () => {
    const result = diffMergedSettings({ x: 'old' }, { x: 'new' });
    expect(result.missing).toEqual([]);
    expect(result.changed).toEqual(['x']);
    expect(result.extra).toEqual([]);
  });

  it('handles arrays of different lengths (shorter vs longer)', () => {
    const result = diffMergedSettings({ a: [1, 2, 3] }, { a: [1, 2] });
    expect(result.changed).toEqual(['a']);
  });

  it('handles deeply nested changed value', () => {
    const result = diffMergedSettings(
      { outer: { inner: { deep: 'a' } } },
      { outer: { inner: { deep: 'b' } } },
    );
    expect(result.changed).toEqual(['outer']);
  });

  it('reports changed when merged object has fewer keys than settings object (different key count)', () => {
    // objectsEqual: aKeys.length !== bKeys.length -> false -> changed
    const result = diffMergedSettings({ obj: { x: 1 } }, { obj: { x: 1, y: 2 } });
    expect(result.changed).toEqual(['obj']);
  });

  it('reports changed when merged object has a key not present in settings object (same length)', () => {
    // objectsEqual: hasOwnProperty check -> false -> changed
    const result = diffMergedSettings({ obj: { x: 1 } }, { obj: { y: 1 } });
    expect(result.changed).toEqual(['obj']);
  });

  it('reports changed when merged has an array and settings has a non-array for the same key', () => {
    // deepEqual: Array.isArray(a) || Array.isArray(b) mixed-type -> false -> changed
    const result = diffMergedSettings({ a: [1, 2] }, { a: 'not-an-array' });
    expect(result.changed).toEqual(['a']);
  });

  it('reports changed when merged has a non-array and settings has an array for the same key', () => {
    // deepEqual: Array.isArray(b) but not a -> false -> changed
    const result = diffMergedSettings({ a: 'not-an-array' }, { a: [1, 2] });
    expect(result.changed).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// Reporter tests (filesystem-based via makeDoctorEnv)
// ---------------------------------------------------------------------------

describe('reportSettingsDriftCheck', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = undefined;
    env = makeDoctorEnv({ host: 'test-host', writeBase: false, writeSettings: false });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  /**
   * Run the reporter through a fresh module graph and return the joined items.
   *
   * @returns Section items joined by newline.
   */
  async function runCheck(): Promise<{ out: string; items: string[] }> {
    vi.resetModules();
    const { section } = await import('./commands.doctor.format.ts');
    const { reportSettingsDriftCheck } = await import('./commands.doctor.checks.settings-drift.ts');
    const sec = section('Settings');
    reportSettingsDriftCheck(sec);
    return { out: sec.items.join('\n'), items: sec.items };
  }

  it('emits a dim info skip when settings.json is absent', async () => {
    const { out } = await runCheck();
    expect(out).toContain(infoGlyph);
    expect(out).toContain('skipping merge-drift check');
    expect(out).not.toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits a dim info skip when shared/settings.base.json is missing', async () => {
    // Write settings but NOT base
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    const { out } = await runCheck();
    expect(out).toContain(infoGlyph);
    expect(out).toContain('skipping merge-drift check');
    expect(out).not.toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits silent skip and leaves exitCode undefined on malformed settings.json', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(join(env.testHome, '.claude', 'settings.json'), '{ not valid json\n');
    let threw = false;
    try {
      await runCheck();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits silent skip and leaves exitCode undefined on malformed base.json', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      '{ bad json\n',
    );
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    let threw = false;
    try {
      await runCheck();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits ok line when settings matches deepMerge(base, host)', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    const { out } = await runCheck();
    expect(out).toContain(okGlyph);
    expect(out).toContain('settings.json matches base+host merge');
    expect(out).not.toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits a yellow warn for missing merged key with nomad pull hint', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet', hooks: {} }) + '\n',
    );
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    const { out } = await runCheck();
    expect(out).toContain(warnGlyph);
    expect(out).toContain('hooks');
    expect(out).toContain('nomad pull');
    expect(out).toContain('merged keys missing locally');
    expect(process.exitCode).toBeUndefined();
  });

  it('emits a yellow warn for changed merged key value', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus' }) + '\n',
    );
    const { out } = await runCheck();
    expect(out).toContain(warnGlyph);
    expect(out).toContain('model');
    expect(out).toContain('nomad pull');
    expect(out).toContain('merged keys with changed values');
    expect(process.exitCode).toBeUndefined();
  });

  it('emits a dim info for extra local-only keys (not a warn)', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet', agentPushNotifEnabled: true }) + '\n',
    );
    const { out } = await runCheck();
    expect(out).toContain(infoGlyph);
    expect(out).toContain('agentPushNotifEnabled');
    expect(out).toContain('promotion candidates');
    expect(out).not.toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('applies host override: base + host merged = settings -> clean (no false drift)', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'hosts', 'test-host.json'),
      JSON.stringify({ model: 'opus' }) + '\n',
    );
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus' }) + '\n',
    );
    const { out } = await runCheck();
    expect(out).toContain(okGlyph);
    expect(out).toContain('settings.json matches base+host merge');
    expect(out).not.toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('never prints the value of a drifting key (secret-leakage guard)', async () => {
    const secretValue = 'super-secret-api-key-12345';
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet', apiKey: secretValue }) + '\n',
    );
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus' }) + '\n',
    );
    const { out } = await runCheck();
    expect(out).not.toContain(secretValue);
    // drift is reported (changed model, missing apiKey) but value is not shown
    expect(out).toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits both warn rows when both missing and changed drift exist', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet', hooks: {}, statusLine: 'on' }) + '\n',
    );
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus' }) + '\n',
    );
    const { out } = await runCheck();
    expect(out).toContain('merged keys missing locally');
    expect(out).toContain('merged keys with changed values');
    expect(process.exitCode).toBeUndefined();
  });

  it('exitCode remains undefined after a warn scenario (WARN never sets exitCode)', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet', hooks: {} }) + '\n',
    );
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus' }) + '\n',
    );
    await runCheck();
    expect(process.exitCode).toBeUndefined();
  });

  it('silently skips when settings.json contains JSON array (not a plain object)', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    // JSON array is valid JSON but not an object -> tryReadJson returns null -> silent skip
    writeFileSync(join(env.testHome, '.claude', 'settings.json'), JSON.stringify([1, 2, 3]) + '\n');
    let threw = false;
    try {
      await runCheck();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('silently skips when base.json contains a JSON array (not a plain object)', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify([1, 2, 3]) + '\n',
    );
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    let threw = false;
    try {
      await runCheck();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits malformed host json skip (not throw) and exitCode stays undefined', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(join(env.testHome, 'claude-nomad', 'hosts', 'test-host.json'), '{ bad\n');
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    let threw = false;
    try {
      await runCheck();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cmdDoctor integration: drift row appears in Settings section output
// ---------------------------------------------------------------------------

describe('cmdDoctor Settings section: drift row wiring', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = undefined;
    env = makeDoctorEnv({ host: 'test-host', writeBase: false, writeSettings: false });
    // Provide minimal settings.base.json so loadBaseSettings does not FAIL
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet', hooks: {} }) + '\n',
    );
    // settings.json drops 'hooks' -> drift WARN expected
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: {} }) + '\n',
    );
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('cmdDoctor Settings output contains the drift warn row with key name and nomad pull hint', async () => {
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    const { joinedLog } = await import('./commands.doctor.checks.test-helpers.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(warnGlyph);
    expect(out).toContain('hooks');
    expect(out).toContain('nomad pull');
    expect(process.exitCode).toBeUndefined();
  });

  it('cmdDoctor does NOT print the secret value in a drift warn row', async () => {
    // Override base to include a secret-shaped key value
    const secretValue = 'secret-sentinel-value-xyz';
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet', apiKey: secretValue }) + '\n',
    );
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    const { joinedLog } = await import('./commands.doctor.checks.test-helpers.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain(secretValue);
  });
});
