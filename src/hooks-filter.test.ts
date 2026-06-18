import { describe, expect, it } from 'vitest';

import { isGsdHookEntry, stripGsdHookEntries } from './hooks-filter.ts';

// ---------------------------------------------------------------------------
// isGsdHookEntry -- Test 1-7
// ---------------------------------------------------------------------------

describe('isGsdHookEntry', () => {
  it('Test 1: bare node launcher with gsd- script -> true', () => {
    expect(isGsdHookEntry('node /a/b/.claude/hooks/gsd-context-monitor.js')).toBe(true);
  });

  it('Test 2: node with --preserve-symlinks-main flag -> true', () => {
    expect(isGsdHookEntry('node --preserve-symlinks-main /a/hooks/gsd-workflow-guard.js')).toBe(
      true,
    );
  });

  it('Test 3: absolute nvm launcher path + gsd- script -> true', () => {
    expect(
      isGsdHookEntry('/home/u/.nvm/versions/node/v24/bin/node /a/hooks/gsd-config-reload.js'),
    ).toBe(true);
  });

  it('Test 4: bash launcher with gsd- .sh script -> true', () => {
    expect(isGsdHookEntry('bash /a/hooks/gsd-graphify-update.sh')).toBe(true);
  });

  it('Test 5: user-authored script (no gsd- prefix) -> false', () => {
    expect(isGsdHookEntry('node /a/hooks/my-personal-hook.js')).toBe(false);
  });

  it('Test 6: gsd- is a directory segment but the basename is not gsd- prefixed -> false', () => {
    expect(isGsdHookEntry('node /a/hooks/gsd-foo/runner.js')).toBe(false);
  });

  it('Test 7a: empty command -> false (fail-safe)', () => {
    expect(isGsdHookEntry('')).toBe(false);
  });

  it('Test 7b: command with no script token (launcher only) -> false (fail-safe)', () => {
    expect(isGsdHookEntry('node')).toBe(false);
  });

  it('Test 7c: command with only flags after launcher -> false (fail-safe)', () => {
    expect(isGsdHookEntry('node --flag1 --flag2')).toBe(false);
  });

  it('script token with no path separator (bare basename) -> detected by prefix', () => {
    // Covers the lastSlash < 0 branch in isGsdHookEntry (token is just a basename).
    expect(isGsdHookEntry('node gsd-hook.js')).toBe(true);
    expect(isGsdHookEntry('node my-hook.js')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stripGsdHookEntries -- Test 8-14
// ---------------------------------------------------------------------------

/** Build a minimal gsd-owned inner hook entry. */
function gsdHook(suffix = 'context-monitor.js'): Record<string, unknown> {
  return { type: 'command', command: `node /a/hooks/gsd-${suffix}` };
}

/** Build a minimal user-authored inner hook entry. */
function userHook(): Record<string, unknown> {
  return { type: 'command', command: 'node /a/hooks/my-personal-hook.js' };
}

describe('stripGsdHookEntries', () => {
  it('Test 8: all-gsd matcher -> removes entry, event key, hooks key entirely', () => {
    const input = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [gsdHook()] }],
      },
    };
    const result = stripGsdHookEntries(input);
    expect(result).not.toHaveProperty('hooks');
  });

  it('Test 9: mixed matcher (gsd + user) -> drops gsd entry only; rest survives', () => {
    const input = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [gsdHook(), userHook()] }],
      },
    };
    const result = stripGsdHookEntries(input);
    expect(result).toHaveProperty('hooks');
    const event = (result.hooks as Record<string, unknown>).PreToolUse as unknown[];
    expect(event).toHaveLength(1);
    const entry = event[0] as Record<string, unknown>;
    const inner = entry.hooks as unknown[];
    expect(inner).toHaveLength(1);
    expect((inner[0] as Record<string, unknown>).command).toBe('node /a/hooks/my-personal-hook.js');
  });

  it('Test 10: matcher with only user hooks -> untouched', () => {
    const input = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [userHook()] }],
      },
    };
    const result = stripGsdHookEntries(input);
    expect(result).toHaveProperty('hooks');
    const event = (result.hooks as Record<string, unknown>).PreToolUse as unknown[];
    expect(event).toHaveLength(1);
  });

  it('Test 11: two events, one all-gsd (empty after strip), one user -> empty event removed', () => {
    const input = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [gsdHook()] }],
        Stop: [{ matcher: '', hooks: [userHook()] }],
      },
    };
    const result = stripGsdHookEntries(input);
    expect(result).toHaveProperty('hooks');
    const hooks = result.hooks as Record<string, unknown>;
    expect(hooks).not.toHaveProperty('PreToolUse');
    expect(hooks).toHaveProperty('Stop');
  });

  it('Test 12: no hooks key -> returned object unchanged, input not mutated', () => {
    const input = { permissions: { allow: ['*'] } };
    const result = stripGsdHookEntries(input);
    expect(result).toEqual(input);
    // Confirm no mutation.
    expect(Object.keys(input)).toEqual(['permissions']);
  });

  it('Test 13: non-hooks keys pass through unchanged', () => {
    const input = {
      permissions: { allow: ['*'] },
      env: { FOO: 'bar' },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [gsdHook()] }],
      },
    };
    const result = stripGsdHookEntries(input);
    expect(result.permissions).toBe(input.permissions);
    expect(result.env).toBe(input.env);
    expect(result).not.toHaveProperty('hooks');
  });

  it('Test 14a: hooks value is a string -> passed through unchanged (fail-safe)', () => {
    const input = { hooks: 'not-an-object' };
    const result = stripGsdHookEntries(input);
    expect(result.hooks).toBe('not-an-object');
  });

  it('Test 14b: event value is not an array -> passed through unchanged (fail-safe)', () => {
    const input = {
      hooks: {
        PreToolUse: 'not-an-array',
      },
    };
    const result = stripGsdHookEntries(input);
    const hooks = result.hooks as Record<string, unknown>;
    expect(hooks.PreToolUse).toBe('not-an-array');
  });

  it('Test 14c: matcher entry lacks inner hooks array -> passed through unchanged (fail-safe)', () => {
    const input = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash' }],
      },
    };
    const result = stripGsdHookEntries(input);
    const hooks = result.hooks as Record<string, unknown>;
    const event = hooks.PreToolUse as unknown[];
    expect(event).toHaveLength(1);
    expect((event[0] as Record<string, unknown>).matcher).toBe('Bash');
  });

  it('inner hooks array entry that is null -> preserved (fail-safe branch)', () => {
    // Covers the `h === null` branch inside filterMatcherEntry.
    const input = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [null] }],
      },
    };
    const result = stripGsdHookEntries(input);
    const hooks = result.hooks as Record<string, unknown>;
    const event = hooks.PreToolUse as unknown[];
    const entry = event[0] as Record<string, unknown>;
    expect((entry.hooks as unknown[])[0]).toBeNull();
  });

  it('inner hooks array entry that is an array -> preserved (fail-safe branch)', () => {
    // Covers the `Array.isArray(h)` branch inside filterMatcherEntry.
    const input = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [['not', 'an', 'object']] }],
      },
    };
    const result = stripGsdHookEntries(input);
    const hooks = result.hooks as Record<string, unknown>;
    const event = hooks.PreToolUse as unknown[];
    const entry = event[0] as Record<string, unknown>;
    expect(entry.hooks).toEqual([['not', 'an', 'object']]);
  });

  it('matcher entry in event array that is null -> treated as empty, event removed (fail-safe branch)', () => {
    // Covers the `entry === null` branch in filterMatcherEntry.
    // null is not a valid matcher entry; it is returned as-is but the caller
    // filterEventMatchers treats the null result as "drop this entry", so an
    // event with only a null matcher entry becomes empty and is removed.
    const input = {
      hooks: {
        PreToolUse: [null],
        Stop: [{ matcher: '', hooks: [userHook()] }],
      },
    };
    const result = stripGsdHookEntries(input);
    const hooks = result.hooks as Record<string, unknown>;
    // PreToolUse had only a null entry -> empty after filtering -> event removed.
    expect(hooks).not.toHaveProperty('PreToolUse');
    // Stop survives.
    expect(hooks).toHaveProperty('Stop');
  });

  it('inner hook entry with no command property -> treated as non-gsd (fail-safe)', () => {
    // Covers the `hookObj['command'] ?? ''` null-coalesce branch (command absent).
    const input = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' }] }],
      },
    };
    const result = stripGsdHookEntries(input);
    const hooks = result.hooks as Record<string, unknown>;
    // command is absent so isGsdHookEntry('') = false -> entry preserved
    const event = hooks.PreToolUse as unknown[];
    expect(event).toHaveLength(1);
  });
});
