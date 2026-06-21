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
    // Use a user-authored hook entry so the hooks key survives stripping and
    // remains in the missing bucket (an empty hooks block would be stripped out).
    const merged = {
      model: 'claude-sonnet',
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'node /x/my-hook.js' }],
          },
        ],
      },
      statusLine: 'on',
      enabledPlugins: ['plugin-a'],
    };
    const settings = {
      agentPushNotifEnabled: true,
      inputNeededNotifEnabled: false,
    };
    const result = diffMergedSettings(merged, settings);
    // missing: all four merged keys (hooks survives strip because it has a user entry), sorted
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

  it('emits a distinct unparseable skip (not "missing") on malformed base.json', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      '{ bad json\n',
    );
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    let threw = false;
    let out = '';
    try {
      out = (await runCheck()).out;
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // The file is present but malformed: the row must say unparseable, not
    // missing, so it agrees with loadBaseSettings' malformed-JSON FAIL.
    expect(out).toContain('shared/settings.base.json unparseable');
    expect(out).not.toContain('settings.base.json missing');
    expect(out).toContain(infoGlyph);
    expect(out).not.toContain(warnGlyph);
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
    // Use a user-authored hook entry so the hooks key survives stripping and
    // shows up as missing from settings. An empty `hooks: {}` would be stripped.
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({
        model: 'sonnet',
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /x/my-hook.js' }] },
          ],
        },
      }) + '\n',
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
    expect(out).toContain('nomad diff');
    expect(out).toContain('diverged from the base+host merge');
    expect(process.exitCode).toBeUndefined();
  });

  it('reads clean when hooks differ only by node launcher path form (no changed warn)', async () => {
    // base uses canonical bare `node`; the live file carries the same hook with
    // an absolute launcher path an external installer wrote. These normalize
    // equal, so the check must report a match, not changed drift.
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ command: 'node "$HOME/.claude/hooks/x.js"' }] }] },
      }) + '\n',
    );
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { command: '/home/u/.nvm/versions/node/v24/bin/node "$HOME/.claude/hooks/x.js"' },
              ],
            },
          ],
        },
      }) + '\n',
    );
    const { out } = await runCheck();
    expect(out).toContain('settings.json matches base+host merge');
    expect(out).not.toContain('diverged');
    expect(process.exitCode).toBeUndefined();
  });

  it('emits a dim info for extra local-only keys when a host file exists (not a warn)', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'hosts', 'test-host.json'),
      JSON.stringify({}) + '\n',
    );
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet', agentPushNotifEnabled: true }) + '\n',
    );
    const { out } = await runCheck();
    expect(out).toContain(infoGlyph);
    expect(out).toContain('agentPushNotifEnabled');
    expect(out).toContain('nomad capture-settings');
    expect(out).not.toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits a name-free count row for excluded local-only keys (no capture advice, no secret name)', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'hosts', 'test-host.json'),
      JSON.stringify({}) + '\n',
    );
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet', env: { ANTHROPIC_API_KEY: 'sk-secret' } }) + '\n',
    );
    const { out } = await runCheck();
    expect(out).toContain('outside the sync set');
    // Excluded keys are never named and never advised for capture.
    expect(out).not.toContain('nomad capture-settings');
    expect(out).not.toContain('env');
    expect(out).not.toContain('sk-secret');
    expect(out).not.toContain('settings.json matches base+host merge');
    expect(process.exitCode).toBeUndefined();
  });

  it('names only promotable keys and counts excluded keys when local-only keys are mixed', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'hosts', 'test-host.json'),
      JSON.stringify({}) + '\n',
    );
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'sonnet',
        statusLine: { type: 'command' },
        env: { ANTHROPIC_API_KEY: 'sk-secret' },
      }) + '\n',
    );
    const { out } = await runCheck();
    expect(out).toContain('statusLine');
    expect(out).toContain('nomad capture-settings');
    expect(out).toContain('outside the sync set');
    expect(out).not.toContain('env');
    expect(out).not.toContain('sk-secret');
    expect(process.exitCode).toBeUndefined();
  });

  it('suppresses the extra-keys info row when no host file exists (reportHostOverrides FAILs those keys)', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    // No hosts/test-host.json: the unbased extra key is reportHostOverrides'
    // FAIL territory; a softer promotion info row would contradict it.
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet', agentPushNotifEnabled: true }) + '\n',
    );
    const { out } = await runCheck();
    expect(out).not.toContain('promotion candidates');
    // Extras exist, so settings does not match the merge: no false ok row either.
    expect(out).not.toContain('settings.json matches base+host merge');
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
    expect(out).toContain('diverged from the base+host merge');
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

  it('reports unparseable skip when base.json contains a JSON array (not a plain object)', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify([1, 2, 3]) + '\n',
    );
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    let threw = false;
    let out = '';
    try {
      out = (await runCheck()).out;
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(out).toContain('shared/settings.base.json unparseable');
    expect(process.exitCode).toBeUndefined();
  });

  it('warns on malformed host json (a real pull would die on it) without setting exitCode', async () => {
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
    let out = '';
    try {
      out = (await runCheck()).out;
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // A base-only merge would compare clean here, but pull would die on the
    // host file: the check must warn, not report a false-healthy match.
    expect(out).toContain(warnGlyph);
    expect(out).toContain('hosts/test-host.json unparseable');
    expect(out).toContain('nomad pull');
    expect(out).not.toContain('settings.json matches base+host merge');
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
    // Provide minimal settings.base.json so loadBaseSettings does not FAIL.
    // Use a user-authored hook entry so the hooks key survives stripping and
    // appears as missing in settings (an empty hooks block would be stripped).
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({
        model: 'sonnet',
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /x/my-hook.js' }] },
          ],
        },
      }) + '\n',
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

  it('Test 8: gsd-only hooks divergence produces no changed row (doctor path)', async () => {
    // Override base so it has gsd-only hooks; settings has a different gsd hook
    // set (the self-heal scenario). After stripping both sides, hooks is absent
    // from both -> no drift row. The doctor adapter inherits this via classifySettingsDrift.
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({
        model: 'sonnet',
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'node /a/hooks/gsd-context-monitor.js' }],
            },
          ],
        },
      }) + '\n',
    );
    // Live settings has a different gsd hook set.
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'sonnet',
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'node /a/hooks/gsd-workflow-guard.js' }],
            },
          ],
        },
      }) + '\n',
    );
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    const { joinedLog } = await import('./commands.doctor.checks.test-helpers.ts');
    // verbose: compact mode strips passing rows, leaving only the always-kept
    // Nomad Version row to carry the okGlyph assertion. That row is a PASS glyph
    // only when the local version equals the latest published release; during a
    // release's own npm publish it reads as "ahead of latest" (an info glyph), so
    // assert okGlyph against the full verbose tree where the Settings PASS survives.
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    // No drift row for hooks: the gsd-only divergence is filtered out.
    expect(out).not.toContain(warnGlyph + ' settings.json drift');
    expect(out).toContain(okGlyph);
  });
});

// ---------------------------------------------------------------------------
// reportHooksBaseSelfCleanNote (one-time migration info-line)
// ---------------------------------------------------------------------------

describe('reportHooksBaseSelfCleanNote', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let env: Env;

  const gsdEntry = {
    type: 'command',
    command: 'node /home/u/.claude/hooks/gsd-context-monitor.js',
  };
  const userEntry = {
    type: 'command',
    command: 'node /home/u/my-hooks/my-personal-hook.js',
  };

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
   * Run reportHooksBaseSelfCleanNote through a fresh module graph.
   *
   * @returns Section items joined by newline.
   */
  async function runNote(): Promise<{ out: string; items: string[] }> {
    vi.resetModules();
    const { section } = await import('./commands.doctor.format.ts');
    const { reportHooksBaseSelfCleanNote } =
      await import('./commands.doctor.checks.settings-drift.ts');
    const sec = section('Settings');
    reportHooksBaseSelfCleanNote(sec);
    return { out: sec.items.join('\n'), items: sec.items };
  }

  it('Test 1: base with >= 1 gsd hook entry emits a dim info line (not a WARN)', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({
        model: 'sonnet',
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [gsdEntry] }],
        },
      }) + '\n',
    );
    const { out } = await runNote();
    expect(out).toContain(infoGlyph);
    expect(out).toContain("self-cleans on your next 'nomad push'");
    expect(out).not.toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('Test 2: base with no gsd hook entries emits nothing (already clean)', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({
        model: 'sonnet',
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [userEntry] }],
        },
      }) + '\n',
    );
    const { items } = await runNote();
    expect(items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('Test 3: absent base emits nothing (best-effort skip)', async () => {
    // No base file written.
    const { items } = await runNote();
    expect(items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('Test 3b: unparseable base emits nothing (best-effort skip)', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      '{ NOT VALID JSON\n',
    );
    let threw = false;
    try {
      await runNote();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('Test 4: the note never sets process.exitCode (guidance only)', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({
        model: 'sonnet',
        hooks: { Stop: [{ matcher: '', hooks: [gsdEntry] }] },
      }) + '\n',
    );
    const { out } = await runNote();
    expect(out).toContain(infoGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('base with no hooks key at all emits nothing', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    const { items } = await runNote();
    expect(items).toHaveLength(0);
  });

  it('base with empty hooks: {} scaffold (no gsd entries) emits nothing', async () => {
    // An empty hooks block has NO gsd entries, so the note must not fire and
    // the push must not rewrite the base (nothing to clean). Before the fix,
    // stripGsdHookEntries dropped the empty hooks key -> JSON.stringify diff ->
    // spurious note and rewrite.
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet', hooks: {} }) + '\n',
    );
    const { items } = await runNote();
    expect(items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('base with hooks: { Event: [] } (empty event, no gsd entries) emits nothing', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet', hooks: { PreToolUse: [] } }) + '\n',
    );
    const { items } = await runNote();
    expect(items).toHaveLength(0);
  });
});
