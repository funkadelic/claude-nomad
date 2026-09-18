import { describe, expect, it } from 'vitest';

import {
  blockedSettingsKeys,
  credentialOverwriteCount,
  credentialOverwriteMessage,
  settingsBlockedMessage,
} from './settings-guard.ts';

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
});

describe('credentialOverwriteCount', () => {
  it('counts a live-only credential key the merge would drop', () => {
    expect(credentialOverwriteCount({ a: 1 }, { a: 1, env: { K: 'v' } }, {})).toBe(1);
  });

  it('counts every excluded key independently of the promotable ones', () => {
    const live = { env: { K: 'v' }, apiKeyHelper: '/bin/key', theme: 'dark' };
    expect(credentialOverwriteCount({}, live, {})).toBe(2);
  });

  it('returns 0 when the credential key is also in the merge', () => {
    expect(credentialOverwriteCount({ env: { K: 'v' } }, { env: { K: 'v' } }, {})).toBe(0);
  });

  it('does not count a credential key the pre-pull merge had (removed upstream)', () => {
    expect(credentialOverwriteCount({}, { env: { K: 'v' } }, { env: { K: 'old' } })).toBe(0);
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
