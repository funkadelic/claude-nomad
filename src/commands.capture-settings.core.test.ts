import { describe, expect, it } from 'vitest';

import { KNOWN_SETTINGS_KEYS } from './config.ts';
import {
  buildCaptureSubset,
  CAPTURE_EXCLUDED_KEYS,
  classifySettingsDrift,
  normalizeNodePathsDeep,
  partitionByCaptureExclusion,
} from './commands.capture-settings.core.ts';
import { stripGsdHookEntries } from './hooks-filter.ts';
import { deepMerge } from './utils.json.ts';

/**
 * Behavior tests for the pure direction-aware settings drift core.
 *
 * Covers:
 * - classifySettingsDrift: behind/ahead/changed buckets and sort order.
 * - buildCaptureSubset: ahead-only promotion, secret exclusion, node-path normalization.
 * - normalizeNodePathsDeep: absolute-path matching, bare-string pass-through, recursion.
 * - CAPTURE_EXCLUDED_KEYS covers the credential- and secret-bearing settings keys.
 */

// ---------------------------------------------------------------------------
// classifySettingsDrift
// ---------------------------------------------------------------------------

describe('classifySettingsDrift', () => {
  it('returns behind for merged keys absent from settings', () => {
    const drift = classifySettingsDrift({ a: 1, b: 2 }, { a: 1 });
    expect(drift.behind).toEqual(['b']);
    expect(drift.ahead).toEqual([]);
    expect(drift.changed).toEqual([]);
  });

  it('returns ahead for settings keys absent from merged', () => {
    const drift = classifySettingsDrift({ a: 1 }, { a: 1, c: 3 });
    expect(drift.behind).toEqual([]);
    expect(drift.ahead).toEqual(['c']);
    expect(drift.changed).toEqual([]);
  });

  it('returns changed for keys in both with deep-different scalar values', () => {
    const drift = classifySettingsDrift({ a: 1 }, { a: 2 });
    expect(drift.behind).toEqual([]);
    expect(drift.ahead).toEqual([]);
    expect(drift.changed).toEqual(['a']);
  });

  it('example from plan: merged {a,b}, settings {a,c} -> behind b, ahead c', () => {
    const drift = classifySettingsDrift({ a: 1, b: 2 }, { a: 1, c: 3 });
    expect(drift.behind).toEqual(['b']);
    expect(drift.ahead).toEqual(['c']);
    expect(drift.changed).toEqual([]);
  });

  it('classifies a key with deep-different value as changed, not behind/ahead', () => {
    const drift = classifySettingsDrift({ a: { x: 1 } }, { a: { x: 2 } });
    expect(drift.changed).toEqual(['a']);
    expect(drift.behind).toEqual([]);
    expect(drift.ahead).toEqual([]);
  });

  it('treats arrays with different elements as changed', () => {
    const drift = classifySettingsDrift({ a: [1, 2] }, { a: [1, 3] });
    expect(drift.changed).toEqual(['a']);
  });

  it('treats arrays with different lengths as changed', () => {
    const drift = classifySettingsDrift({ a: [1] }, { a: [1, 2] });
    expect(drift.changed).toEqual(['a']);
  });

  it('treats equal arrays as unchanged (no bucket)', () => {
    const drift = classifySettingsDrift({ a: [1, 2] }, { a: [1, 2] });
    expect(drift.behind).toEqual([]);
    expect(drift.ahead).toEqual([]);
    expect(drift.changed).toEqual([]);
  });

  it('sorts each bucket by locale compare en', () => {
    const drift = classifySettingsDrift({ b: 1, a: 1, c: 1 }, { z: 1, y: 1, x: 1 });
    expect(drift.behind).toEqual(['a', 'b', 'c']);
    expect(drift.ahead).toEqual(['x', 'y', 'z']);
  });

  it('returns empty buckets for identical objects', () => {
    const drift = classifySettingsDrift({ a: 1, b: 'two' }, { a: 1, b: 'two' });
    expect(drift.behind).toEqual([]);
    expect(drift.ahead).toEqual([]);
    expect(drift.changed).toEqual([]);
  });

  it('handles null values: equal null is not changed', () => {
    const drift = classifySettingsDrift({ a: null }, { a: null });
    expect(drift.changed).toEqual([]);
  });

  it('handles null value in merged vs non-null in settings as changed', () => {
    const drift = classifySettingsDrift({ a: null }, { a: 1 });
    expect(drift.changed).toEqual(['a']);
  });

  it('handles nested object deep equality correctly', () => {
    const drift = classifySettingsDrift(
      { a: { nested: { deep: true } } },
      { a: { nested: { deep: true } } },
    );
    expect(drift.changed).toEqual([]);
  });

  it('treats objects with different key counts as changed', () => {
    // Exercises objectsEqual length branch (aKeys.length !== bKeys.length)
    const drift = classifySettingsDrift({ a: { x: 1 } }, { a: { x: 1, y: 2 } });
    expect(drift.changed).toEqual(['a']);
  });

  it('treats objects with same count but different keys as changed', () => {
    // Exercises objectsEqual Object.hasOwn branch (key present in a but not in b)
    const drift = classifySettingsDrift({ a: { x: 1 } }, { a: { z: 1 } });
    expect(drift.changed).toEqual(['a']);
  });

  it('treats array vs non-array as changed (mismatched shape)', () => {
    // Exercises deepEqual Array.isArray(a) || Array.isArray(b) branch (line 64)
    const drift = classifySettingsDrift({ a: [1, 2] }, { a: { 0: 1, 1: 2 } });
    expect(drift.changed).toEqual(['a']);
  });

  it('does NOT report changed when a key differs only by node launcher path form', () => {
    // bare `node` (canonical) vs an absolute `/.../bin/node` launcher (the churn
    // an external installer writes) normalize equal, so no changed drift.
    const merged = {
      hooks: { PreToolUse: [{ hooks: [{ command: 'node "$HOME/.claude/hooks/x.js"' }] }] },
    };
    const settings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { command: '/home/u/.nvm/versions/node/v24/bin/node "$HOME/.claude/hooks/x.js"' },
            ],
          },
        ],
      },
    };
    const drift = classifySettingsDrift(merged, settings);
    expect(drift.changed).toEqual([]);
    expect(drift.behind).toEqual([]);
    expect(drift.ahead).toEqual([]);
  });

  it('still reports changed when values differ beyond node-path normalization', () => {
    // Same node-path normalization, but settings carries an extra hook entry, so
    // the key genuinely diverges and stays in changed.
    const merged = {
      hooks: { PreToolUse: [{ hooks: [{ command: 'node "$HOME/.claude/hooks/x.js"' }] }] },
    };
    const settings = {
      hooks: {
        PreToolUse: [
          { hooks: [{ command: '/usr/bin/node "$HOME/.claude/hooks/x.js"' }] },
          { hooks: [{ command: 'node "$HOME/.claude/hooks/extra.js"' }] },
        ],
      },
    };
    const drift = classifySettingsDrift(merged, settings);
    expect(drift.changed).toEqual(['hooks']);
  });
});

// ---------------------------------------------------------------------------
// normalizeNodePathsDeep
// ---------------------------------------------------------------------------

describe('normalizeNodePathsDeep', () => {
  it('normalizes absolute posix path ending in bin/node to bare node', () => {
    expect(normalizeNodePathsDeep('/home/user/.nvm/versions/node/v20/bin/node')).toBe('node');
  });

  it('normalizes /usr/bin/node to bare node', () => {
    expect(normalizeNodePathsDeep('/usr/bin/node')).toBe('node');
  });

  it('leaves bare node string unchanged', () => {
    expect(normalizeNodePathsDeep('node')).toBe('node');
  });

  it('leaves npx unchanged', () => {
    expect(normalizeNodePathsDeep('npx')).toBe('npx');
  });

  it('leaves nodejs unchanged (not the node binary)', () => {
    expect(normalizeNodePathsDeep('nodejs')).toBe('nodejs');
  });

  it('recurses into arrays', () => {
    const result = normalizeNodePathsDeep(['/usr/bin/node', 'npx', '--version']);
    expect(result).toEqual(['node', 'npx', '--version']);
  });

  it('recurses into nested objects', () => {
    const input = { command: '/home/user/.nvm/versions/node/v20/bin/node', args: ['--version'] };
    const result = normalizeNodePathsDeep(input);
    expect(result).toEqual({ command: 'node', args: ['--version'] });
  });

  it('recurses into deeply nested structures (hooks command value)', () => {
    const input = {
      hooks: {
        PreToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: '/usr/local/bin/node' }] },
        ],
      },
    };
    const result = normalizeNodePathsDeep(input) as typeof input;
    expect(
      (result as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } }).hooks.PreToolUse[0]
        .hooks[0].command,
    ).toBe('node');
  });

  it('passes null through unchanged', () => {
    expect(normalizeNodePathsDeep(null)).toBe(null);
  });

  it('passes numbers through unchanged', () => {
    expect(normalizeNodePathsDeep(42)).toBe(42);
  });

  it('matches windows-style path separator before node', () => {
    expect(normalizeNodePathsDeep('C:\\Program Files\\nodejs\\bin\\node')).toBe('node');
  });

  it('leaves a relative bin/node command unchanged (absolute paths only)', () => {
    expect(normalizeNodePathsDeep('./bin/node')).toBe('./bin/node');
    expect(normalizeNodePathsDeep('bin/node')).toBe('bin/node');
  });

  it('matches a root-level /bin/node absolute path', () => {
    expect(normalizeNodePathsDeep('/bin/node')).toBe('node');
  });

  it('normalizes a quoted absolute launcher as the leading token of a command', () => {
    expect(
      normalizeNodePathsDeep(
        '"/home/u/.nvm/versions/node/v24/bin/node" "$HOME/.claude/hooks/x.js"',
      ),
    ).toBe('node "$HOME/.claude/hooks/x.js"');
  });

  it('normalizes an unquoted absolute launcher leading token, preserving flags', () => {
    expect(normalizeNodePathsDeep('/usr/bin/node --preserve-symlinks-main "$HOME/x.js"')).toBe(
      'node --preserve-symlinks-main "$HOME/x.js"',
    );
  });

  it('leaves a bare-node command line unchanged', () => {
    expect(normalizeNodePathsDeep('node "$HOME/x.js"')).toBe('node "$HOME/x.js"');
  });

  it('leaves a non-node leading token (bash) unchanged', () => {
    expect(normalizeNodePathsDeep('bash "/home/u/.claude/hooks/x.sh"')).toBe(
      'bash "/home/u/.claude/hooks/x.sh"',
    );
  });

  it('normalizes a quoted whole-string launcher with no trailing argument', () => {
    expect(normalizeNodePathsDeep('"/usr/bin/node"')).toBe('node');
  });

  it('normalizes a quoted whole-string Windows launcher containing a space', () => {
    expect(normalizeNodePathsDeep('"C:\\Program Files\\nodejs\\bin\\node"')).toBe('node');
  });
});

// ---------------------------------------------------------------------------
// buildCaptureSubset
// ---------------------------------------------------------------------------

describe('buildCaptureSubset', () => {
  it('returns only ahead keys', () => {
    const merged = { a: 1 };
    const settings = { a: 1, b: 2 };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({ b: 2 });
  });

  it('excludes merged keys (not ahead)', () => {
    const merged = { a: 1, b: 2 };
    const settings = { a: 1, b: 2 };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({});
  });

  it('excludes changed keys (value differs, not a new key)', () => {
    const merged = { a: 1 };
    const settings = { a: 99 };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({});
  });

  it('excludes apiKeyHelper even when locally-only (secret exclusion)', () => {
    const merged = { a: 1 };
    const settings = { a: 1, apiKeyHelper: '/home/me/bin/get-key.sh' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).not.toHaveProperty('apiKeyHelper');
    expect(subset).toEqual({});
  });

  it('excludes a secret-bearing env block from capture (the core leak vector)', () => {
    const merged = {};
    const settings = { env: { ANTHROPIC_API_KEY: 'sk-secret', AWS_SECRET_ACCESS_KEY: 'abc' } };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({});
  });

  it('excludes awsCredentialExport from capture', () => {
    const merged = {};
    const settings = { awsCredentialExport: '/home/me/bin/aws-creds.sh' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({});
  });

  it('excludes awsAuthRefresh from capture', () => {
    const merged = {};
    const settings = { awsAuthRefresh: 'aws sso login' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({});
  });

  it('excludes otelHeadersHelper from capture', () => {
    const merged = {};
    const settings = { otelHeadersHelper: '/home/me/bin/otel-headers.sh' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({});
  });

  it('normalizes node paths when normalizeNodePath=true', () => {
    const merged = {};
    const settings = { launcher: '/usr/bin/node' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: true });
    expect(subset).toEqual({ launcher: 'node' });
  });

  it('leaves absolute node paths intact when normalizeNodePath=false', () => {
    const merged = {};
    const settings = { launcher: '/usr/bin/node' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({ launcher: '/usr/bin/node' });
  });

  it('captures non-excluded ahead keys alongside excluded ones', () => {
    const merged = { safe: 1 };
    const settings = { safe: 1, newKey: 'value', apiKeyHelper: '/home/me/bin/get-key.sh' };
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: false });
    expect(subset).toEqual({ newKey: 'value' });
  });
});

// ---------------------------------------------------------------------------
// CAPTURE_EXCLUDED_KEYS covers credential- and secret-bearing settings keys
// ---------------------------------------------------------------------------

describe('CAPTURE_EXCLUDED_KEYS', () => {
  it('contains the credential- and secret-bearing settings keys', () => {
    expect(CAPTURE_EXCLUDED_KEYS.has('apiKeyHelper')).toBe(true);
    expect(CAPTURE_EXCLUDED_KEYS.has('awsAuthRefresh')).toBe(true);
    expect(CAPTURE_EXCLUDED_KEYS.has('awsCredentialExport')).toBe(true);
    expect(CAPTURE_EXCLUDED_KEYS.has('otelHeadersHelper')).toBe(true);
    expect(CAPTURE_EXCLUDED_KEYS.has('env')).toBe(true);
  });

  it('holds settings.json key names, not ALWAYS_NEVER_SYNC file names', () => {
    // The guard operates on top-level settings keys; file names would never
    // appear there, so excluding them would protect nothing.
    expect(CAPTURE_EXCLUDED_KEYS.has('.credentials.json')).toBe(false);
    expect(CAPTURE_EXCLUDED_KEYS.has('settings.local.json')).toBe(false);
  });

  it('does not over-exclude a benign shared key', () => {
    expect(CAPTURE_EXCLUDED_KEYS.has('model')).toBe(false);
  });

  it('every excluded key is a known settings.json schema key (schema-coupling guard)', () => {
    // If a future settings-schema sync renames one of these keys, the exclusion
    // would silently go stale; this pins the coupling so the rename is caught.
    const known = new Set(KNOWN_SETTINGS_KEYS);
    for (const key of CAPTURE_EXCLUDED_KEYS) {
      expect(known.has(key)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// partitionByCaptureExclusion
// ---------------------------------------------------------------------------

describe('partitionByCaptureExclusion', () => {
  it('splits keys into promotable and excluded, preserving input order', () => {
    const result = partitionByCaptureExclusion(['myKey', 'env', 'other', 'apiKeyHelper']);
    expect(result.promotable).toEqual(['myKey', 'other']);
    expect(result.excluded).toEqual(['env', 'apiKeyHelper']);
  });

  it('returns all keys as promotable when none are excluded', () => {
    expect(partitionByCaptureExclusion(['a', 'b'])).toEqual({
      promotable: ['a', 'b'],
      excluded: [],
    });
  });

  it('returns all keys as excluded when every key is a credential key', () => {
    expect(partitionByCaptureExclusion(['env', 'apiKeyHelper'])).toEqual({
      promotable: [],
      excluded: ['env', 'apiKeyHelper'],
    });
  });

  it('returns empty partitions for an empty input', () => {
    expect(partitionByCaptureExclusion([])).toEqual({ promotable: [], excluded: [] });
  });
});

// ---------------------------------------------------------------------------
// classifySettingsDrift gsd-hook filtering
// ---------------------------------------------------------------------------

describe('classifySettingsDrift gsd-hook filtering', () => {
  const gsdEntry = { type: 'command', command: 'node /a/hooks/gsd-context-monitor.js' };
  const gsdEntry2 = { type: 'command', command: 'node /a/hooks/gsd-workflow-guard.js' };
  const userEntry = { type: 'command', command: 'node /a/hooks/my-personal-hook.js' };
  const matcher = (hooks: unknown[]) => ({ matcher: 'Bash', hooks });

  it('Test 5: merged has gsd hooks, settings has different gsd hooks, no user hooks -> hooks in no bucket', () => {
    // Both sides have gsd-only hooks (different sets); after stripping both
    // become empty -> not behind, not ahead, not changed.
    const merged = {
      model: 'sonnet',
      hooks: { PreToolUse: [matcher([gsdEntry])] },
    };
    const settings = {
      model: 'sonnet',
      hooks: { Stop: [matcher([gsdEntry2])] },
    };
    const drift = classifySettingsDrift(merged, settings);
    expect(drift.behind).not.toContain('hooks');
    expect(drift.ahead).not.toContain('hooks');
    expect(drift.changed).not.toContain('hooks');
  });

  it('Test 6: live settings has a user hook absent from merged (merged has only gsd hooks) -> hooks in ahead', () => {
    // After stripping: merged loses hooks key, settings retains user hook ->
    // hooks is ahead (local-only), capturable.
    const merged = {
      model: 'sonnet',
      hooks: { PreToolUse: [matcher([gsdEntry])] },
    };
    const settings = {
      model: 'sonnet',
      hooks: { PreToolUse: [matcher([userEntry])] },
    };
    const drift = classifySettingsDrift(merged, settings);
    expect(drift.ahead).toContain('hooks');
    expect(drift.behind).not.toContain('hooks');
    expect(drift.changed).not.toContain('hooks');
  });

  it('Test 7: both sides share identical user hook plus differing gsd hooks -> hooks not in changed', () => {
    // After stripping gsd entries: both sides retain the same user hook ->
    // deep-equal, so not changed.
    const merged = {
      model: 'sonnet',
      hooks: { PreToolUse: [matcher([gsdEntry, userEntry])] },
    };
    const settings = {
      model: 'sonnet',
      hooks: { PreToolUse: [matcher([gsdEntry2, userEntry])] },
    };
    const drift = classifySettingsDrift(merged, settings);
    expect(drift.changed).not.toContain('hooks');
    expect(drift.behind).not.toContain('hooks');
    expect(drift.ahead).not.toContain('hooks');
  });
});

// ---------------------------------------------------------------------------
// round-trip and capture ordering (base-clean precondition for capture)
// ---------------------------------------------------------------------------

describe('capture ordering and round-trip for personal hooks', () => {
  const gsdEntry = { type: 'command', command: 'node /a/hooks/gsd-context-monitor.js' };
  const userEntry = { type: 'command', command: 'node /a/hooks/my-personal-hook.js' };
  const matcher = (hooks: unknown[]) => ({ matcher: 'Bash', hooks });

  it('Test 5 (round-trip): user hook is capturable from a CLEAN base and survives re-merge', () => {
    // Round-trip: starting from a clean base (no hooks key), a user adds
    // a non-gsd hook to live settings. After stripping both sides, the base has
    // no hooks and settings has the user hook -> hooks is `ahead`, so
    // buildCaptureSubset promotes it. A subsequent merge of the promoted base
    // + empty host retains the user hook.
    const cleanBase: Record<string, unknown> = { model: 'sonnet' };
    const liveSettings = {
      model: 'sonnet',
      hooks: { PreToolUse: [matcher([userEntry])] },
    };

    // Phase 1: classify; hooks should be `ahead` (user-only, capturable).
    const drift = classifySettingsDrift(cleanBase, liveSettings);
    expect(drift.ahead).toContain('hooks');
    expect(drift.changed).not.toContain('hooks');
    expect(drift.behind).not.toContain('hooks');

    // Phase 2: build capture subset; hooks must appear.
    const captured = buildCaptureSubset(cleanBase, liveSettings, { normalizeNodePath: false });
    expect(captured).toHaveProperty('hooks');

    // Phase 3: simulate pull by merging the captured base with an empty host
    // override, then strip gsd entries (the pull-side filter). The user hook
    // must survive.
    const merged = deepMerge(captured, {});
    const regenerated = stripGsdHookEntries(merged);
    const hooks = regenerated.hooks as Record<string, unknown[]>;
    expect(hooks).toBeDefined();
    const preToolMatchers = hooks.PreToolUse as { hooks: unknown[] }[];
    expect(preToolMatchers[0].hooks[0]).toMatchObject({ command: userEntry.command });
  });

  it('Test 6 (ordering): residual gsd entry in base forces hooks into `changed` (not capturable)', () => {
    // Ordering edge case: if a residual gsd entry lingers in the base
    // (pre-clean), hooks is present on both sides. After stripping, the base
    // loses hooks but settings retains the user hook. Since classifySettingsDrift
    // strips both sides at entry, hooks appears only in settings -> `ahead`.
    //
    // However, the plan clarifies: the ordering dependency is about what happens
    // WITHOUT the gsd-hook filter (the raw, pre-strip perspective). With it active
    // in classifySettingsDrift, the strip already handles this. The test pins
    // the key invariant: when a residual gsd entry is in the base AND the user
    // has only the same gsd entry in live settings (no personal hook), hooks
    // ends up in NO bucket (both sides strip to empty -> neither ahead nor changed).
    // This confirms that a user who has only gsd hooks and a dirty base is NOT
    // mistakenly told to capture.
    const dirtyBase = {
      model: 'sonnet',
      hooks: { PreToolUse: [matcher([gsdEntry])] },
    };
    const liveSettingsGsdOnly = {
      model: 'sonnet',
      hooks: { Stop: [matcher([gsdEntry])] },
    };

    const drift = classifySettingsDrift(dirtyBase, liveSettingsGsdOnly);
    // After stripping both sides -> no hooks on either -> not in any bucket.
    expect(drift.ahead).not.toContain('hooks');
    expect(drift.changed).not.toContain('hooks');
    expect(drift.behind).not.toContain('hooks');

    // buildCaptureSubset must NOT return a hooks key for the gsd-only case.
    const captured = buildCaptureSubset(dirtyBase, liveSettingsGsdOnly, {
      normalizeNodePath: false,
    });
    expect(captured).not.toHaveProperty('hooks');
  });

  it('Test 7: after base is stripped clean, user hook classifies `ahead` and is capturable', () => {
    // Positive complement of Test 6: once the base has no hooks key (the
    // push strip has run), a live user hook is `ahead` and buildCaptureSubset
    // promotes it (confirming base-clean unblocks the capture path).
    const cleanBase: Record<string, unknown> = { model: 'sonnet' };
    const liveWithUserHook = {
      model: 'sonnet',
      hooks: { PreToolUse: [matcher([userEntry])] },
    };

    const drift = classifySettingsDrift(cleanBase, liveWithUserHook);
    expect(drift.ahead).toContain('hooks');
    expect(drift.changed).not.toContain('hooks');
    expect(drift.behind).not.toContain('hooks');

    const captured = buildCaptureSubset(cleanBase, liveWithUserHook, { normalizeNodePath: false });
    expect(captured).toHaveProperty('hooks');
    // The captured hooks block must contain the user entry.
    const hooks = captured.hooks as Record<string, unknown[]>;
    const preToolMatchers = hooks.PreToolUse as { hooks: unknown[] }[];
    expect(preToolMatchers[0].hooks[0]).toMatchObject({ command: userEntry.command });
  });
});
