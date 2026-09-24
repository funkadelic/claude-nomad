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
});
