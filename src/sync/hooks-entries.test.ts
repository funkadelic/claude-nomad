import { describe, expect, it } from 'vitest';

import {
  buildHookCaptureSubset,
  hookEntryIds,
  hookEntryLabel,
  liveOnlyHookEntries,
} from './hooks-entries.ts';

const stopHook = { type: 'command', command: 'stop-cmd' };
const preToolHook = { type: 'command', command: 'pre-cmd' };

describe('liveOnlyHookEntries', () => {
  it('returns [] when live matches merged exactly', () => {
    const merged = { hooks: { Stop: [{ matcher: '', hooks: [stopHook] }] } };
    expect(liveOnlyHookEntries(merged, merged)).toEqual([]);
  });

  it('returns [] when merged has no hooks key at all (the whole-key gate owns that shape)', () => {
    const live = { hooks: { Stop: [{ matcher: '', hooks: [stopHook] }] } };
    expect(liveOnlyHookEntries({}, live)).toEqual([]);
  });

  it('returns the live-only entry when live adds a second event', () => {
    const merged = { hooks: { Stop: [{ matcher: '', hooks: [stopHook] }] } };
    const live = {
      hooks: {
        Stop: [{ matcher: '', hooks: [stopHook] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [preToolHook] }],
      },
    };
    const result = liveOnlyHookEntries(merged, live);
    expect(result).toHaveLength(1);
    expect(result[0].event).toBe('PreToolUse');
  });
});

describe('hookEntryIds', () => {
  it('treats a missing matcher field the same as an empty matcher', () => {
    const withMatcher = { hooks: { Stop: [{ matcher: '', hooks: [stopHook] }] } };
    const noMatcher = { hooks: { Stop: [{ hooks: [stopHook] }] } };
    expect(hookEntryIds(withMatcher)).toEqual(hookEntryIds(noMatcher));
  });

  it('yields the same id for an absolute node launcher and the bare launcher', () => {
    const abs = {
      hooks: {
        Stop: [
          { matcher: '', hooks: [{ type: 'command', command: '/usr/bin/node "$HOME/x.js"' }] },
        ],
      },
    };
    const bare = {
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node "$HOME/x.js"' }] }],
      },
    };
    expect(hookEntryIds(abs)).toEqual(hookEntryIds(bare));
  });
});

describe('hookEntryLabel', () => {
  it('names the event and command when the command is short and printable', () => {
    const merged = { hooks: { Stop: [{ matcher: '', hooks: [stopHook] }] } };
    const live = {
      hooks: {
        Stop: [{ matcher: '', hooks: [stopHook] }],
        PreToolUse: [{ matcher: '', hooks: [preToolHook] }],
      },
    };
    const [entry] = liveOnlyHookEntries(merged, live);
    expect(hookEntryLabel(entry)).toBe("PreToolUse hook 'pre-cmd'");
  });

  it('names only the event for a non-object inner hook value', () => {
    const merged = { hooks: { Stop: [{ matcher: '', hooks: [stopHook] }] } };
    const live = { hooks: { Stop: [{ matcher: '', hooks: [stopHook, 'not-an-object'] }] } };
    const [entry] = liveOnlyHookEntries(merged, live);
    expect(hookEntryLabel(entry)).toBe('Stop hook');
  });
});

describe('identity', () => {
  const promptHook = { type: 'prompt', prompt: 'do the thing' };

  it('blocks a live-only prompt-type hook with no command', () => {
    const merged = { hooks: { Stop: [{ matcher: '', hooks: [stopHook] }] } };
    const live = { hooks: { Stop: [{ matcher: '', hooks: [stopHook, promptHook] }] } };
    const result = liveOnlyHookEntries(merged, live);
    expect(result).toHaveLength(1);
    expect(hookEntryLabel(result[0])).toBe('Stop hook');
  });

  it('does not block the same prompt-type hook when its keys are reordered in the merge', () => {
    const reordered = { prompt: 'do the thing', type: 'prompt' };
    const merged = { hooks: { Stop: [{ matcher: '', hooks: [reordered] }] } };
    const live = { hooks: { Stop: [{ matcher: '', hooks: [promptHook] }] } };
    expect(liveOnlyHookEntries(merged, live)).toEqual([]);
  });

  it('handles a non-object inner hook value without throwing', () => {
    const merged = { hooks: { Stop: [{ matcher: '', hooks: [stopHook] }] } };
    const live = { hooks: { Stop: [{ matcher: '', hooks: [stopHook, 'not-an-object'] }] } };
    expect(() => liveOnlyHookEntries(merged, live)).not.toThrow();
  });
});

describe('security', () => {
  it('yields no entry for a __proto__ event key and does not pollute Object.prototype', () => {
    const merged = { hooks: { Stop: [{ matcher: '', hooks: [stopHook] }] } };
    const raw =
      '{"hooks":{"Stop":[{"matcher":"","hooks":[' +
      JSON.stringify(stopHook) +
      ']}],"__proto__":[{"matcher":"","hooks":[{"type":"command","command":"evil"}]}]}}';
    const live = JSON.parse(raw) as Record<string, unknown>;
    expect(liveOnlyHookEntries(merged, live)).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('buildHookCaptureSubset (base destination)', () => {
  const stopEntry = { matcher: '', hooks: [stopHook] };
  const base = { hooks: { Stop: [stopEntry] } };

  it('adds a new event with the live entries', () => {
    const live = {
      hooks: { Stop: [stopEntry], PreToolUse: [{ matcher: '', hooks: [preToolHook] }] },
    };
    const result = buildHookCaptureSubset(
      { base, overrides: {}, merged: base, settings: live },
      false,
    );
    expect(result.hooks).toEqual({ PreToolUse: [{ matcher: '', hooks: [preToolHook] }] });
    expect(result.skipped).toEqual([]);
  });

  it('appends a second matcher entry to the base array for an existing event', () => {
    const xEntry = { matcher: 'Write', hooks: [{ type: 'command', command: 'x-cmd' }] };
    const live = { hooks: { Stop: [stopEntry, xEntry] } };
    const result = buildHookCaptureSubset(
      { base, overrides: {}, merged: base, settings: live },
      false,
    );
    expect(result.hooks).toEqual({ Stop: [stopEntry, xEntry] });
  });

  it('contributes only the new inner hook from a matcher entry mixing merge-carried and live-only', () => {
    const xHook = { type: 'command', command: 'x-cmd' };
    const live = { hooks: { Stop: [{ matcher: '', hooks: [stopHook, xHook] }] } };
    const result = buildHookCaptureSubset(
      { base, overrides: {}, merged: base, settings: live },
      false,
    );
    expect(result.hooks).toEqual({ Stop: [stopEntry, { matcher: '', hooks: [xHook] }] });
  });

  it('normalizes an absolute node launcher path in a captured entry', () => {
    const live = {
      hooks: {
        Stop: [stopEntry],
        PreToolUse: [
          { matcher: '', hooks: [{ type: 'command', command: '/usr/local/bin/node /x/hook.js' }] },
        ],
      },
    };
    const result = buildHookCaptureSubset(
      { base, overrides: {}, merged: base, settings: live },
      false,
    );
    const captured = result.hooks.PreToolUse[0] as { hooks: [{ command: string }] };
    expect(captured.hooks[0].command).toBe('node /x/hook.js');
  });

  it('skips an event the host file already sets, reporting it in skipped', () => {
    const overrides = {
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'host-cmd' }] }] },
    };
    const xHook = { type: 'command', command: 'x-cmd' };
    const live = { hooks: { Stop: [stopEntry, { matcher: '', hooks: [xHook] }] } };
    const result = buildHookCaptureSubset({ base, overrides, merged: base, settings: live }, false);
    expect(result.hooks).toEqual({});
    expect(result.skipped).toEqual(['Stop']);
  });

  it('returns empty hooks and skipped when there is no live-only entry', () => {
    const result = buildHookCaptureSubset(
      { base, overrides: {}, merged: base, settings: base },
      false,
    );
    expect(result.hooks).toEqual({});
    expect(result.skipped).toEqual([]);
  });
});

describe('malformed shapes', () => {
  const merged = { hooks: { Stop: [{ matcher: '', hooks: [stopHook] }] } };

  it('skips an event value that is not an array', () => {
    const live = {
      hooks: { Stop: [{ matcher: '', hooks: [stopHook] }], PreToolUse: 'not-an-array' },
    };
    expect(() => liveOnlyHookEntries(merged, live)).not.toThrow();
    expect(liveOnlyHookEntries(merged, live)).toEqual([]);
  });

  it('skips a matcher entry that is not an object', () => {
    const live = {
      hooks: { Stop: [{ matcher: '', hooks: [stopHook] }], PreToolUse: ['not-an-object'] },
    };
    expect(liveOnlyHookEntries(merged, live)).toEqual([]);
  });

  it('skips a matcher entry without a hooks array', () => {
    const live = {
      hooks: { Stop: [{ matcher: '', hooks: [stopHook] }], PreToolUse: [{ matcher: '' }] },
    };
    expect(liveOnlyHookEntries(merged, live)).toEqual([]);
  });
});
