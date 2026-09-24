import { describe, expect, it } from 'vitest';

import { hookEntryIds, hookEntryLabel, liveOnlyHookEntries } from './hooks-entries.ts';

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
