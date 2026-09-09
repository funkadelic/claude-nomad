import { describe, expect, it } from 'vitest';

import {
  baseHasGsdHookEntries,
  graftGsdHookEntries,
  isGsdHookEntry,
  keepGsdHookEntries,
  stripGsdHookEntries,
} from './hooks-filter.ts';

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

  it('env-prefixed gsd command -> true', () => {
    // CLAUDE_PROJECT_DIR=/x is a KEY=value token; the detector must skip it and
    // identify `node` as the launcher and `gsd-x.js` as the script.
    expect(isGsdHookEntry('CLAUDE_PROJECT_DIR=/x node /a/hooks/gsd-x.js')).toBe(true);
  });

  it('env-prefixed user command -> false', () => {
    expect(isGsdHookEntry('MY_VAR=1 node /a/hooks/my-personal-hook.js')).toBe(false);
  });

  it('multiple env-prefix tokens then gsd script -> true', () => {
    expect(isGsdHookEntry('FOO=bar BAZ=qux node /a/hooks/gsd-monitor.js')).toBe(true);
  });

  it('single-token gsd script path (no launcher) -> true', () => {
    // A shebang-executable invoked directly: no separate launcher token.
    expect(isGsdHookEntry('/a/hooks/gsd-x.js')).toBe(true);
  });

  it('single-token bare launcher (no script) -> false', () => {
    // `node` alone has no path separator and no gsd- prefix: unparseable -> false.
    expect(isGsdHookEntry('node')).toBe(false);
  });

  it('single-token user script path -> false', () => {
    expect(isGsdHookEntry('/a/hooks/my-personal-hook.js')).toBe(false);
  });

  it('launcher-less gsd script WITH trailing flag -> true', () => {
    // The script token carries args; classification keys off the script, not the args.
    expect(isGsdHookEntry('/a/hooks/gsd-x.js --flag')).toBe(true);
  });

  it('launcher-less user script with a gsd-prefixed ARGUMENT -> false', () => {
    // Must NOT claim a user script as gsd-owned just because an argument starts
    // with gsd-; the only safe failure is keeping the user entry.
    expect(isGsdHookEntry('/a/hooks/my-hook.sh gsd-arg')).toBe(false);
  });

  it('absolute launcher binary running a gsd script -> true', () => {
    // First token has a path but its basename is a known launcher (node), so the
    // script token after it is what gates ownership.
    expect(isGsdHookEntry('/usr/bin/node /a/hooks/gsd-x.js')).toBe(true);
  });

  it('single-token gsd- prefix with no path separator -> true', () => {
    // Covers the `lastSlash < 0` else branch in the single-token path.
    expect(isGsdHookEntry('gsd-hook.js')).toBe(true);
  });

  it('all-env-assignment command (no script token) -> false (fail-safe)', () => {
    // Covers the `tokens[i] ?? ''` nullish branch when i >= tokens.length
    // (every token was an env assignment and no script token remains).
    expect(isGsdHookEntry('FOO=bar')).toBe(false);
    expect(isGsdHookEntry('FOO=bar BAZ=qux')).toBe(false);
  });

  it('quoted absolute node launcher + quoted gsd script -> true', () => {
    // The form gsd actually writes into settings.json: both the launcher and
    // the script path are wrapped in literal double quotes. Without unquoting,
    // the launcher basename reads as `node"` and evades launcher detection.
    expect(
      isGsdHookEntry(
        '"/home/u/.nvm/versions/node/v24/bin/node" "/home/u/.claude/hooks/gsd-config-reload.js"',
      ),
    ).toBe(true);
  });

  it('quoted node launcher + quoted $HOME gsd script -> true', () => {
    expect(
      isGsdHookEntry(
        '"/home/u/.nvm/versions/node/v24/bin/node" "$HOME/.claude/hooks/gsd-context-monitor.js"',
      ),
    ).toBe(true);
  });

  it('quoted launcher + quoted USER script -> false (no over-stripping)', () => {
    // Unquoting must not cause a false positive: a user-authored script in the
    // same quoted form stays user-owned.
    expect(
      isGsdHookEntry('"/home/u/.nvm/versions/node/v24/bin/node" "$HOME/.claude/hooks/my-hook.js"'),
    ).toBe(false);
  });

  it('single-quoted launcher and gsd script -> true', () => {
    expect(isGsdHookEntry("'/usr/bin/node' '/a/hooks/gsd-x.js'")).toBe(true);
  });

  it('launcher-less quoted gsd script -> true', () => {
    expect(isGsdHookEntry('"/a/hooks/gsd-x.js"')).toBe(true);
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

  it('sparse-array hole in event array -> dropped (not serialized as null)', () => {
    // Calling filterEventMatchers with a sparse array directly: an undefined hole
    // must be dropped by the loose != null guard, not pushed as null.
    // Simulate via a regular array containing undefined.
    const undefinedEntry = undefined as unknown;
    const input = {
      hooks: {
        PreToolUse: [undefinedEntry, { matcher: '', hooks: [userHook()] }],
      },
    };
    const result = stripGsdHookEntries(input);
    const hooks = result.hooks as Record<string, unknown>;
    const event = hooks.PreToolUse as unknown[];
    // undefined hole should be dropped; only the user-hook matcher remains.
    expect(event).toHaveLength(1);
    expect(event[0]).not.toBeNull();
    expect(event[0]).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// keepGsdHookEntries -- the KEEP complement of stripGsdHookEntries
// ---------------------------------------------------------------------------

/** Narrow a value to a plain (non-null, non-array) object, or null otherwise. */
function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Push every inner hook `command` string of one matcher entry into `out`. */
function collectMatcherCommands(entry: unknown, out: string[]): void {
  const entryObj = asObject(entry);
  if (entryObj === null || !Array.isArray(entryObj.hooks)) return;
  for (const h of entryObj.hooks as unknown[]) {
    const cmd = asObject(h)?.command;
    if (typeof cmd === 'string') out.push(cmd);
  }
}

/**
 * Collect every inner hook `command` string from a settings-shaped object's
 * `hooks` block, in a flat sorted array, for the keep/strip partition test.
 * Ignores any non-array/non-object shape so it can walk a filtered subtree.
 *
 * @param settings - A settings-shaped object (or a keep/strip result subtree).
 * @returns Sorted list of inner hook command strings found under `hooks`.
 */
function collectCommands(settings: Record<string, unknown>): string[] {
  const out: string[] = [];
  const hooks = asObject(settings.hooks);
  if (hooks === null) return out;
  for (const matchers of Object.values(hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const entry of matchers) collectMatcherCommands(entry, out);
  }
  return out.sort((a, b) => a.localeCompare(b, 'en'));
}

describe('keepGsdHookEntries', () => {
  it('gsd-only matcher -> keeps the entry, event key, and hooks key', () => {
    const input = {
      hooks: {
        SessionStart: [{ matcher: '', hooks: [gsdHook()] }],
      },
    };
    const result = keepGsdHookEntries(input);
    expect(result).toEqual(input);
  });

  it('user-only matcher -> returns {} (no hooks key)', () => {
    const input = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [userHook()] }],
      },
    };
    expect(keepGsdHookEntries(input)).toEqual({});
  });

  it('mixed matcher (gsd + user) -> keeps only the gsd inner hook', () => {
    const input = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [gsdHook(), userHook()] }],
      },
    };
    const result = keepGsdHookEntries(input);
    const event = (result.hooks as Record<string, unknown>).PreToolUse as unknown[];
    expect(event).toHaveLength(1);
    const inner = (event[0] as Record<string, unknown>).hooks as unknown[];
    expect(inner).toHaveLength(1);
    expect((inner[0] as Record<string, unknown>).command).toBe(
      'node /a/hooks/gsd-context-monitor.js',
    );
  });

  it('no gsd hooks anywhere -> {}', () => {
    const input = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [userHook()] }],
        Stop: [{ matcher: '', hooks: [userHook()] }],
      },
    };
    expect(keepGsdHookEntries(input)).toEqual({});
  });

  it('no hooks key at all -> {}', () => {
    expect(keepGsdHookEntries({ model: 'sonnet', permissions: { allow: ['*'] } })).toEqual({});
  });

  it('non-hooks keys are dropped (keep returns only the hooks subtree)', () => {
    const input = {
      model: 'sonnet',
      env: { FOO: 'bar' },
      hooks: {
        SessionStart: [{ matcher: '', hooks: [gsdHook()] }],
      },
    };
    const result = keepGsdHookEntries(input);
    expect(result).not.toHaveProperty('model');
    expect(result).not.toHaveProperty('env');
    expect(result).toHaveProperty('hooks');
  });

  it('two events, one gsd one user -> keeps only the gsd event key', () => {
    const input = {
      hooks: {
        SessionStart: [{ matcher: '', hooks: [gsdHook()] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [userHook()] }],
      },
    };
    const result = keepGsdHookEntries(input);
    const hooks = result.hooks as Record<string, unknown>;
    expect(hooks).toHaveProperty('SessionStart');
    expect(hooks).not.toHaveProperty('PreToolUse');
  });

  it('fail-safe: hooks value is a string -> {}', () => {
    expect(keepGsdHookEntries({ hooks: 'not-an-object' })).toEqual({});
  });

  it('fail-safe: hooks value is null -> {}', () => {
    expect(keepGsdHookEntries({ hooks: null })).toEqual({});
  });

  it('fail-safe: hooks value is an array -> {}', () => {
    expect(keepGsdHookEntries({ hooks: [] })).toEqual({});
  });

  it('fail-safe: event value is not an array -> {}', () => {
    expect(keepGsdHookEntries({ hooks: { SessionStart: 'not-an-array' } })).toEqual({});
  });

  it('fail-safe: null matcher entry -> dropped, {}', () => {
    expect(keepGsdHookEntries({ hooks: { SessionStart: [null] } })).toEqual({});
  });

  it('fail-safe: array matcher entry -> dropped, {}', () => {
    expect(keepGsdHookEntries({ hooks: { SessionStart: [['not', 'an', 'object']] } })).toEqual({});
  });

  it('fail-safe: matcher without inner hooks array -> dropped, {}', () => {
    expect(keepGsdHookEntries({ hooks: { SessionStart: [{ matcher: 'Bash' }] } })).toEqual({});
  });

  it('fail-safe: inner hook that is null -> dropped; only gsd kept', () => {
    const input = {
      hooks: {
        SessionStart: [{ matcher: '', hooks: [null, gsdHook()] }],
      },
    };
    const result = keepGsdHookEntries(input);
    const event = (result.hooks as Record<string, unknown>).SessionStart as unknown[];
    const inner = (event[0] as Record<string, unknown>).hooks as unknown[];
    expect(inner).toHaveLength(1);
    expect((inner[0] as Record<string, unknown>).command).toBe(
      'node /a/hooks/gsd-context-monitor.js',
    );
  });

  it('fail-safe: inner hook whose command is not a string -> dropped, {}', () => {
    const input = {
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command' }] }],
      },
    };
    expect(keepGsdHookEntries(input)).toEqual({});
  });

  it('does not mutate its input', () => {
    const input = {
      model: 'sonnet',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [gsdHook(), userHook()] }],
      },
    };
    const snapshot = JSON.stringify(input);
    keepGsdHookEntries(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('keep and strip partition the hook entries of a mixed fixture (no overlap, no loss)', () => {
    const input = {
      model: 'sonnet',
      hooks: {
        SessionStart: [{ matcher: '', hooks: [gsdHook('check-update.js')] }],
        PreToolUse: [
          { matcher: 'Bash', hooks: [gsdHook(), userHook()] },
          { matcher: 'Edit', hooks: [userHook()] },
        ],
      },
    };
    const kept = collectCommands(keepGsdHookEntries(input));
    const stripped = collectCommands(stripGsdHookEntries(input));
    const all = collectCommands(input);
    // Union of keep and strip commands equals every command, with no overlap.
    expect([...kept, ...stripped].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(all);
    expect(kept.some((c) => stripped.includes(c))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// graftGsdHookEntries -- per-event-key union of preserved gsd hooks
// ---------------------------------------------------------------------------

describe('graftGsdHookEntries', () => {
  it('gsdOnly {} -> base returned byte-identical (no empty hooks scaffold)', () => {
    const base = { model: 'sonnet' };
    const result = graftGsdHookEntries(base, {});
    expect(result).toBe(base);
    expect(JSON.stringify(result)).toBe(JSON.stringify(base));
  });

  it('gsdOnly with empty hooks block -> base returned unchanged', () => {
    const base = { model: 'sonnet' };
    expect(graftGsdHookEntries(base, { hooks: {} })).toBe(base);
  });

  it('base without hooks + gsdOnly hooks -> result.hooks equals gsdOnly.hooks', () => {
    const base = { model: 'sonnet' };
    const gsdOnly = { hooks: { SessionStart: [{ matcher: '', hooks: [gsdHook()] }] } };
    const result = graftGsdHookEntries(base, gsdOnly);
    expect(result.hooks).toEqual(gsdOnly.hooks);
    expect(result.model).toBe('sonnet');
  });

  it('shared event key -> matchers concatenated (user + gsd coexist)', () => {
    const base = {
      hooks: { SessionStart: [{ matcher: 'user', hooks: [userHook()] }] },
    };
    const gsdOnly = {
      hooks: { SessionStart: [{ matcher: 'gsd', hooks: [gsdHook()] }] },
    };
    const result = graftGsdHookEntries(base, gsdOnly);
    const event = (result.hooks as Record<string, unknown>).SessionStart as unknown[];
    expect(event).toHaveLength(2);
    expect((event[0] as Record<string, unknown>).matcher).toBe('user');
    expect((event[1] as Record<string, unknown>).matcher).toBe('gsd');
  });

  it('event key only in gsdOnly -> added alongside base event keys', () => {
    const base = {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [userHook()] }] },
    };
    const gsdOnly = {
      hooks: { SessionStart: [{ matcher: '', hooks: [gsdHook()] }] },
    };
    const result = graftGsdHookEntries(base, gsdOnly);
    const hooks = result.hooks as Record<string, unknown>;
    expect(hooks).toHaveProperty('PreToolUse');
    expect(hooks).toHaveProperty('SessionStart');
  });

  it('dedup: a gsd matcher already present in base is not appended twice', () => {
    const shared = { matcher: '', hooks: [gsdHook()] };
    const base = { hooks: { SessionStart: [{ ...shared, hooks: [gsdHook()] }] } };
    const gsdOnly = { hooks: { SessionStart: [{ ...shared, hooks: [gsdHook()] }] } };
    const result = graftGsdHookEntries(base, gsdOnly);
    const event = (result.hooks as Record<string, unknown>).SessionStart as unknown[];
    expect(event).toHaveLength(1);
  });

  it('dedup is key-order-independent: a gsd matcher matching base only in key order is not duplicated', () => {
    // base authored { matcher, hooks }; gsd authored { hooks, matcher } (same
    // content, different key order). The canonical key must treat them as equal.
    const base = { hooks: { SessionStart: [{ matcher: '', hooks: [gsdHook()] }] } };
    const gsdOnly = { hooks: { SessionStart: [{ hooks: [gsdHook()], matcher: '' }] } };
    const result = graftGsdHookEntries(base, gsdOnly);
    const event = (result.hooks as Record<string, unknown>).SessionStart as unknown[];
    expect(event).toHaveLength(1);
  });

  it('dedup within gsdMatchers: duplicate gsd entries collapse to one', () => {
    const dup = { matcher: '', hooks: [gsdHook()] };
    // base must carry the event as an array so the union path (not the
    // gsd-takes-the-key path) runs and dedups gsdMatchers against itself.
    const base = { hooks: { SessionStart: [] as unknown[] } };
    const gsdOnly = { hooks: { SessionStart: [{ ...dup }, { ...dup }] } };
    const result = graftGsdHookEntries(base, gsdOnly);
    const event = (result.hooks as Record<string, unknown>).SessionStart as unknown[];
    expect(event).toHaveLength(1);
  });

  it('fail-safe: a non-object matcher entry keys off its raw serialization', () => {
    const base = { hooks: { SessionStart: [] as unknown[] } };
    const gsdOnly = { hooks: { SessionStart: [null, null, { matcher: '', hooks: [gsdHook()] }] } };
    const result = graftGsdHookEntries(base, gsdOnly);
    const event = (result.hooks as Record<string, unknown>).SessionStart as unknown[];
    // Both nulls collapse to one, the object entry is kept: length 2.
    expect(event).toHaveLength(2);
    expect(event[0]).toBeNull();
  });

  it('non-hooks base keys pass through by reference', () => {
    const permissions = { allow: ['*'] };
    const base = { permissions, hooks: { Stop: [{ matcher: '', hooks: [userHook()] }] } };
    const gsdOnly = { hooks: { SessionStart: [{ matcher: '', hooks: [gsdHook()] }] } };
    const result = graftGsdHookEntries(base, gsdOnly);
    expect(result.permissions).toBe(permissions);
  });

  it('fail-safe: gsdOnly.hooks is a string -> base unchanged', () => {
    const base = { model: 'sonnet' };
    expect(graftGsdHookEntries(base, { hooks: 'not-an-object' })).toBe(base);
  });

  it('fail-safe: gsdOnly event value is not an array -> that key skipped', () => {
    const base = { hooks: { SessionStart: [{ matcher: '', hooks: [userHook()] }] } };
    const gsdOnly = { hooks: { SessionStart: 'not-an-array' } };
    const result = graftGsdHookEntries(base, gsdOnly);
    // The base SessionStart array is preserved untouched (nothing to union).
    const event = (result.hooks as Record<string, unknown>).SessionStart as unknown[];
    expect(event).toHaveLength(1);
    expect((event[0] as Record<string, unknown>).matcher).toBe('');
  });

  it('fail-safe: base.hooks is not a plain object -> gsd hooks replace it', () => {
    const base = { hooks: 'not-an-object' };
    const gsdOnly = { hooks: { SessionStart: [{ matcher: '', hooks: [gsdHook()] }] } };
    const result = graftGsdHookEntries(base, gsdOnly);
    expect(result.hooks).toEqual(gsdOnly.hooks);
  });

  it('fail-safe: base event value is not an array -> gsd matchers take that key', () => {
    const base = { hooks: { SessionStart: 'not-an-array' } };
    const gsdOnly = { hooks: { SessionStart: [{ matcher: '', hooks: [gsdHook()] }] } };
    const result = graftGsdHookEntries(base, gsdOnly);
    const event = (result.hooks as Record<string, unknown>).SessionStart as unknown[];
    expect(event).toHaveLength(1);
    expect((event[0] as Record<string, unknown>).matcher).toBe('');
  });

  it('does not mutate either input', () => {
    const base = { hooks: { SessionStart: [{ matcher: 'user', hooks: [userHook()] }] } };
    const gsdOnly = { hooks: { SessionStart: [{ matcher: 'gsd', hooks: [gsdHook()] }] } };
    const baseSnapshot = JSON.stringify(base);
    const gsdSnapshot = JSON.stringify(gsdOnly);
    graftGsdHookEntries(base, gsdOnly);
    expect(JSON.stringify(base)).toBe(baseSnapshot);
    expect(JSON.stringify(gsdOnly)).toBe(gsdSnapshot);
  });
});

// ---------------------------------------------------------------------------
// baseHasGsdHookEntries -- predicate used at self-clean call sites
// ---------------------------------------------------------------------------

describe('baseHasGsdHookEntries', () => {
  it('returns true when the hooks block contains at least one gsd entry', () => {
    const base = {
      model: 'sonnet',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [gsdHook()] }],
      },
    };
    expect(baseHasGsdHookEntries(base)).toBe(true);
  });

  it('returns false when the hooks block contains only user entries', () => {
    const base = {
      model: 'sonnet',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [userHook()] }],
      },
    };
    expect(baseHasGsdHookEntries(base)).toBe(false);
  });

  it('returns false for an empty hooks: {} scaffold (no gsd entries present)', () => {
    // An empty hooks object has no gsd entries, so the predicate must
    // return false (no note, no rewrite).
    expect(baseHasGsdHookEntries({ model: 'sonnet', hooks: {} })).toBe(false);
  });

  it('returns false for a hooks block with empty event arrays', () => {
    expect(baseHasGsdHookEntries({ hooks: { PreToolUse: [] } })).toBe(false);
  });

  it('returns false when the hooks key is absent', () => {
    expect(baseHasGsdHookEntries({ model: 'sonnet' })).toBe(false);
  });

  it('returns false when hooks is not a plain object', () => {
    expect(baseHasGsdHookEntries({ hooks: 'not-an-object' })).toBe(false);
    expect(baseHasGsdHookEntries({ hooks: null })).toBe(false);
    expect(baseHasGsdHookEntries({ hooks: [] })).toBe(false);
  });

  it('returns true when gsd entry is in a mixed matcher (gsd + user)', () => {
    const base = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [gsdHook(), userHook()] }],
      },
    };
    expect(baseHasGsdHookEntries(base)).toBe(true);
  });

  it('returns false when the event value is not an array (non-array matchers)', () => {
    // Covers the `if (!Array.isArray(matchers)) continue` branch in baseHasGsdHookEntries.
    const base = { hooks: { PreToolUse: 'not-an-array' } };
    expect(baseHasGsdHookEntries(base)).toBe(false);
  });

  it('matcherHasGsdEntry: non-object entry -> false', () => {
    // The null entry in a matchers array -> matcherHasGsdEntry returns false ->
    // not counted as a gsd entry.
    const base = {
      hooks: {
        PreToolUse: [null],
      },
    };
    expect(baseHasGsdHookEntries(base)).toBe(false);
  });

  it('matcherHasGsdEntry: entry with non-array hooks -> false', () => {
    // Covers the !Array.isArray(entryObj.hooks) branch in matcherHasGsdEntry.
    const base = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: 'not-an-array' }],
      },
    };
    expect(baseHasGsdHookEntries(base)).toBe(false);
  });

  it('matcherHasGsdEntry: inner hook with non-string command -> not gsd (fail-safe)', () => {
    // Covers the `typeof cmd === 'string' ? cmd : ''` branch: when command is
    // absent or non-string, isGsdHookEntry('') returns false.
    const base = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' }] }],
      },
    };
    expect(baseHasGsdHookEntries(base)).toBe(false);
  });

  it('matcherHasGsdEntry: inner hook that is null -> skipped (fail-safe)', () => {
    // Covers the `h === null` branch inside matcherHasGsdEntry.
    const base = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [null, gsdHook()] }],
      },
    };
    // null is skipped; gsdHook() is detected -> true.
    expect(baseHasGsdHookEntries(base)).toBe(true);
  });
});
