import { describe, expect, it } from 'vitest';

import {
  blockedSettingsKeys,
  credentialOverwriteCount,
  credentialOverwriteMessage,
  removedSettingsKeys,
  settingsBlockedMessage,
  settingsRemovedMessage,
  settingValueHash,
  stillAsWritten,
} from './settings-guard.ts';

/** A written-settings record holding each value's hash, as a real write records it. */
function rec(values: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, settingValueHash(v)]));
}

describe('blockedSettingsKeys', () => {
  // `statusLine`, not `hooks`: an empty `hooks: {}` block is stripped away by
  // the shared classifier before comparison (gsd self-heal noise reduction),
  // so it would never register as ahead drift here.
  it('returns the promotable ahead-drift key when the live file has one extra key', () => {
    expect(blockedSettingsKeys({ a: 1 }, { a: 1, statusLine: { type: 'command' } }, {})).toEqual([
      'statusLine',
    ]);
  });

  it('returns empty when the live file matches merged exactly', () => {
    expect(blockedSettingsKeys({ a: 1 }, { a: 1 }, {})).toEqual([]);
  });

  it('excludes a CAPTURE_EXCLUDED_KEYS key (env) from the blocked list', () => {
    expect(blockedSettingsKeys({ a: 1 }, { a: 1, env: { K: 'v' } }, {})).toEqual([]);
  });

  it('does not block a key the pre-pull merge had (removed upstream)', () => {
    const live = { a: 1, statusLine: 1, theme: 'dark' };
    expect(blockedSettingsKeys({ a: 1 }, live, { a: 1, statusLine: 1 })).toEqual(['theme']);
  });

  it('still blocks a user hook when the pre-pull merge only had gsd hooks', () => {
    const gsd = { type: 'command', command: 'node /a/hooks/gsd-check-update.js' };
    const user = { type: 'command', command: 'node /a/hooks/mine.js' };
    const preMerged = { hooks: { SessionStart: [{ matcher: '', hooks: [gsd] }] } };
    const live = { hooks: { SessionStart: [{ matcher: '', hooks: [user] }] } };
    expect(blockedSettingsKeys({}, live, preMerged)).toEqual(['hooks']);
  });

  it('never returns an excluded key even when it is the only ahead key', () => {
    expect(blockedSettingsKeys({}, { env: { K: 'v' } }, {})).toEqual([]);
  });

  it('does not block a key the record names, even when preMerged is empty (removed upstream)', () => {
    const live = { a: 1, theme: 'dark' };
    expect(blockedSettingsKeys({ a: 1 }, live, {}, rec({ theme: 'dark' }))).toEqual([]);
  });

  it('still blocks a key the record does not name (local addition)', () => {
    const live = { a: 1, theme: 'dark' };
    expect(blockedSettingsKeys({ a: 1 }, live, {}, rec({ model: 'x' }))).toEqual(['theme']);
  });

  it('unions preMerged and the record: a key only preMerged had is still excluded', () => {
    const live = { a: 1, statusLine: 1, theme: 'dark' };
    expect(
      blockedSettingsKeys({ a: 1 }, live, { a: 1, statusLine: 1 }, rec({ theme: 'dark' })),
    ).toEqual([]);
  });

  it('an empty record blocks exactly as a null record does', () => {
    const live = { a: 1, theme: 'dark' };
    expect(blockedSettingsKeys({ a: 1 }, live, {}, {})).toEqual(['theme']);
  });

  it('blocks a recorded key whose live value changed since the write (local edit)', () => {
    const live = { a: 1, model: 'opus' };
    expect(blockedSettingsKeys({ a: 1 }, live, {}, rec({ model: 'sonnet' }))).toEqual(['model']);
  });

  it('blocks a key the pre-pull merge had when the live value was edited since (same-pull removal)', () => {
    const live = { a: 1, model: 'opus' };
    expect(blockedSettingsKeys({ a: 1 }, live, { a: 1, model: 'sonnet' })).toEqual(['model']);
  });

  it('keeps a credential key (env) out of the blocked list whether or not the record names it', () => {
    expect(blockedSettingsKeys({ a: 1 }, { a: 1, env: { K: 'v' } }, {}, {})).toEqual([]);
    expect(
      blockedSettingsKeys({ a: 1 }, { a: 1, env: { K: 'v' } }, {}, rec({ env: { K: 'v' } })),
    ).toEqual([]);
  });
});

describe('blockedSettingsKeys hook entries', () => {
  const S = { type: 'command', command: 'stop-cmd' };
  const P = { type: 'command', command: 'pre-cmd' };

  it('blocks a live-only entry under a new event the merge does not have', () => {
    const merged = { hooks: { Stop: [{ matcher: '', hooks: [S] }] } };
    const live = {
      hooks: {
        Stop: [{ matcher: '', hooks: [S] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [P] }],
      },
    };
    expect(blockedSettingsKeys(merged, live, {})).toEqual(["PreToolUse hook '" + P.command + "'"]);
  });

  it('blocks a live-only entry under the same event the merge already has', () => {
    const merged = { hooks: { Stop: [{ matcher: '', hooks: [S] }] } };
    const live = {
      hooks: {
        Stop: [
          { matcher: '', hooks: [S] },
          { matcher: 'x', hooks: [P] },
        ],
      },
    };
    expect(blockedSettingsKeys(merged, live, {})).toEqual(["Stop hook '" + P.command + "'"]);
  });
});

describe('credentialOverwriteCount', () => {
  it('counts a live-only credential key the merge would drop', () => {
    expect(credentialOverwriteCount({ a: 1 }, { a: 1, env: { K: 'v' } })).toBe(1);
  });

  it('counts every excluded key independently of the promotable ones', () => {
    const live = { env: { K: 'v' }, apiKeyHelper: '/bin/key', theme: 'dark' };
    expect(credentialOverwriteCount({}, live)).toBe(2);
  });

  it('returns 0 when the credential key is also in the merge', () => {
    expect(credentialOverwriteCount({ env: { K: 'v' } }, { env: { K: 'v' } })).toBe(0);
  });

  it('counts a credential key removed upstream, which the write still destroys', () => {
    // Unlike the refusal, an upstream removal is no reason to stay quiet: the
    // write keeps only `merged`, so the live value is gone either way.
    expect(credentialOverwriteCount({}, { env: { K: 'v' } })).toBe(1);
  });
});

describe('credentialOverwriteMessage', () => {
  it('reads singular and names no key', () => {
    const msg = credentialOverwriteMessage(1);
    expect(msg).toBe(
      'your settings.json has 1 credential setting that the repo does not carry; ' +
        'a pull overwrites it, so keep per-host credential settings in ' +
        '~/.claude/settings.local.json, which nomad never syncs.',
    );
  });

  it('reads plural and still names no key', () => {
    const msg = credentialOverwriteMessage(2);
    expect(msg).toContain('has 2 credential settings');
    expect(msg).toContain('a pull overwrites them');
    for (const key of ['env', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport']) {
      expect(msg).not.toContain(key);
    }
  });
});

describe('settingsBlockedMessage', () => {
  it('names the key and both ways out, singular', () => {
    expect(settingsBlockedMessage(['hooks'], 'left unchanged')).toBe(
      'settings.json left unchanged: it has 1 setting (hooks) that is not in the repo; ' +
        "run 'nomad capture-settings' to save it (add --host for host-specific values), " +
        'or delete it from ~/.claude/settings.json if you no longer want it, then pull again.',
    );
  });

  it('names both keys and reads plural for two keys in a preview', () => {
    const msg = settingsBlockedMessage(['hooks', 'model'], 'would be left unchanged');
    expect(msg).toContain(
      'settings.json would be left unchanged: it has 2 settings (hooks, model)',
    );
    expect(msg).toContain('that are not in the repo');
    expect(msg).toContain('delete them from ~/.claude/settings.json if you no longer want them');
  });
});

describe('removedSettingsKeys', () => {
  const live = { a: 1, theme: 'dark', statusLine: 1, env: { K: 'v' } };

  it('returns live-only keys the pre-pull merge or the record carried', () => {
    expect(removedSettingsKeys({ a: 1 }, live, { theme: 'dark' }, rec({ statusLine: 1 }))).toEqual([
      'statusLine',
      'theme',
    ]);
  });

  it('excludes keys the pull refuses instead of deleting', () => {
    expect(removedSettingsKeys({ a: 1 }, live, {}, null)).toEqual([]);
  });

  it('leaves credential keys to the count-only WARN', () => {
    expect(removedSettingsKeys({ a: 1 }, live, {}, rec({ env: { K: 'v' } }))).toEqual([]);
  });
});

describe('stillAsWritten', () => {
  it('matches only a recorded key whose live value is unchanged', () => {
    const written = rec({ model: 'sonnet' });
    expect(stillAsWritten(written, { model: 'sonnet' }, 'model')).toBe(true);
    expect(stillAsWritten(written, { model: 'opus' }, 'model')).toBe(false);
    expect(stillAsWritten(written, { theme: 'dark' }, 'theme')).toBe(false);
    expect(stillAsWritten(null, { model: 'sonnet' }, 'model')).toBe(false);
  });

  it('is false, not a throw, for a recorded key the live file lacks', () => {
    expect(stillAsWritten(rec({ model: 'sonnet' }), {}, 'model')).toBe(false);
    expect(stillAsWritten({ toString: 'h' }, {}, 'toString')).toBe(false);
  });

  it('never matches an inherited property name', () => {
    expect(stillAsWritten({}, { constructor: 1 }, 'constructor')).toBe(false);
  });

  it('ignores gsd hook entries the live file gained since the write', () => {
    const userHook = { type: 'command', command: 'node /a/hooks/my-hook.js' };
    const gsdHook = { type: 'command', command: 'node /a/hooks/gsd-context-monitor.js' };
    const hooks = { PreToolUse: [{ matcher: '', hooks: [userHook] }] };
    const live = {
      hooks: { ...hooks, SessionStart: [{ matcher: '', hooks: [gsdHook] }] },
    };
    expect(stillAsWritten(rec({ hooks }), live, 'hooks')).toBe(true);
  });
});

describe('settingsRemovedMessage', () => {
  it('reports a finished pull with its backup file', () => {
    expect(settingsRemovedMessage(['theme'], '20260101-000000')).toBe(
      'this pull removed 1 setting (theme) from settings.json because the repo no longer ' +
        'carries it; the previous file is at ' +
        '~/.cache/claude-nomad/backup/20260101-000000/settings.json.',
    );
  });

  it('previews without a timestamp', () => {
    expect(settingsRemovedMessage(['a', 'b'])).toBe(
      'a pull would remove 2 settings (a, b) from settings.json because the repo no longer ' +
        'carries them.',
    );
  });
});
