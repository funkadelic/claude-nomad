import { describe, expect, it } from 'vitest';

import { blockedSettingsKeys, settingsBlockedMessage } from './settings-guard.ts';

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

describe('settingsBlockedMessage', () => {
  it('names the key and the recovery command, singular', () => {
    const msg = settingsBlockedMessage(['hooks']);
    expect(msg).toContain('hooks');
    expect(msg).toContain('nomad capture-settings --host');
    expect(msg).toContain('1 setting');
    expect(msg).not.toContain('1 settings');
  });

  it('names both keys and reads plural for two keys', () => {
    const msg = settingsBlockedMessage(['hooks', 'model']);
    expect(msg).toContain('hooks');
    expect(msg).toContain('model');
    expect(msg).toContain('2 settings');
  });
});
