import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { warnGlyph } from './color.ts';
import { section } from './commands.doctor.format.ts';
import { reportActionsDrift } from './commands.doctor.actions-drift.ts';
import type { SpawnSyncFn } from './gh-actions.ts';

// Gate-matrix unit tests for the Actions-drift reporter (D-06, D-07, D-08,
// D-09, D-11). The reporter is driven directly with an injected `run` that
// dispatches on (bin, args) to simulate git/gh subprocess outcomes (no real
// spawn, no cmdInit, no HOME/env setup, no vi.doMock): pure section-in/items-out.
// Assertions are on section.items length and substring (the warnGlyph and the
// `gh api -X PUT` remediation hint). process.exitCode is captured and restored
// so every case can assert it stays unset (D-11).

/** Opts shared by the git and gh dispatch helpers below. */
type GhRunOpts = {
  remote?: string;
  remoteThrows?: true;
  auth?: 'ok' | 'not-installed' | 'not-authed' | 'probe-error';
  isPrivateThrows?: true;
  isPrivate?: boolean;
  actionsEnabledThrows?: true;
  actionsEnabled?: boolean;
};

/** Dispatch the `git` bin call for makeGhRun. */
function dispatchGit(opts: GhRunOpts): Buffer {
  if (opts.remoteThrows === true || opts.remote === undefined) {
    throw Object.assign(new Error('no remote'), { code: 128 });
  }
  return Buffer.from(opts.remote + '\n');
}

/** Dispatch the `gh` bin call for makeGhRun. */
function dispatchGh(opts: GhRunOpts, argv: string[]): Buffer {
  if (argv.includes('status')) {
    if (opts.auth === 'not-installed') {
      throw Object.assign(new Error('gh ENOENT'), { code: 'ENOENT' });
    }
    if (opts.auth === 'not-authed') {
      // Clean non-zero exit: numeric status, no terminating signal.
      throw Object.assign(new Error('not authed'), { status: 1, signal: null });
    }
    if (opts.auth === 'probe-error') {
      // Auth-status probe timed out (SIGTERM kill -> null status): indeterminate.
      throw Object.assign(new Error('gh ETIMEDOUT'), {
        code: 'ETIMEDOUT',
        signal: 'SIGTERM',
        status: null,
      });
    }
    return Buffer.from('');
  }
  if (argv.includes('view')) {
    if (opts.isPrivateThrows === true) throw new Error('api error');
    return Buffer.from(JSON.stringify({ isPrivate: opts.isPrivate }));
  }
  if (argv.includes('--jq')) {
    if (opts.actionsEnabledThrows === true) throw new Error('api error');
    return Buffer.from(opts.actionsEnabled ? 'true\n' : 'false\n');
  }
  throw new Error(`Unexpected gh argv: ${argv.join(' ')}`);
}

/**
 * Build a SpawnSyncFn mock that dispatches on (bin, args) to simulate the
 * git/gh subprocess outcomes the Actions-drift gate chain walks. Lifted and
 * trimmed from `init.test.ts`: the `disable`/PUT branch is dropped because the
 * doctor reporter never calls `disableActions` (D-06 reuse, D-08 read-only).
 *
 * @param opts - Per-gate outcome knobs:
 *   `remote` is the origin URL the git probe returns (omit, or set
 *   `remoteThrows`, to simulate gate 1 throwing); `auth` selects the
 *   `gh auth status` outcome; `isPrivate` / `isPrivateThrows` drive gate 4;
 *   `actionsEnabled` / `actionsEnabledThrows` drive gate 5.
 * @returns A SpawnSyncFn suitable as the injected `run` for `reportActionsDrift`.
 */
function makeGhRun(opts: GhRunOpts): SpawnSyncFn {
  return (bin, args) => {
    const argv = Array.from(args);
    if (bin === 'git') return dispatchGit(opts);
    if (bin === 'gh') return dispatchGh(opts, argv);
    throw new Error(`Unexpected subprocess: ${bin} ${argv.join(' ')}`);
  };
}

describe('Actions drift check', () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it('WARNs once when origin is a private GitHub repo, authed, Actions enabled', () => {
    const s = section('Repository');
    reportActionsDrift(
      s,
      makeGhRun({
        remote: 'https://github.com/octo/config.git',
        auth: 'ok',
        isPrivate: true,
        actionsEnabled: true,
      }),
    );
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(warnGlyph);
    // Remediation hint (D-07): the exact gh api PUT shape plus owner/repo.
    expect(s.items[0]).toContain('gh api -X PUT');
    expect(s.items[0]).toContain('repos/octo/config/actions/permissions');
    expect(s.items[0]).toContain('enabled=false');
    expect(s.items[0]).toContain('octo/config');
    expect(process.exitCode).toBeUndefined();
  });

  it('is silent when readOriginRemote throws (gate 1, no remote)', () => {
    const s = section('Repository');
    reportActionsDrift(s, makeGhRun({ remoteThrows: true }));
    expect(s.items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('is silent when the remote is not a GitHub URL (gate 2)', () => {
    const s = section('Repository');
    reportActionsDrift(s, makeGhRun({ remote: 'https://gitlab.com/a/b.git' }));
    expect(s.items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('is silent when gh is not installed (gate 3, no tip unlike init)', () => {
    const s = section('Repository');
    reportActionsDrift(
      s,
      makeGhRun({ remote: 'https://github.com/octo/config.git', auth: 'not-installed' }),
    );
    expect(s.items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('is silent when gh is installed but not authed (gate 3)', () => {
    const s = section('Repository');
    reportActionsDrift(
      s,
      makeGhRun({ remote: 'https://github.com/octo/config.git', auth: 'not-authed' }),
    );
    expect(s.items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('WARNs on a gh-probe-error when the repo is private with Actions enabled (gate 3 fall-through, #124)', () => {
    const s = section('Repository');
    reportActionsDrift(
      s,
      makeGhRun({
        remote: 'https://github.com/octo/config.git',
        auth: 'probe-error',
        isPrivate: true,
        actionsEnabled: true,
      }),
    );
    // A transient auth-status failure must not suppress the drift WARN: gate 3
    // falls through, gates 4-5 succeed, the WARN fires.
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(warnGlyph);
    expect(s.items[0]).toContain('octo/config');
    expect(process.exitCode).toBeUndefined();
  });

  it('is silent on a gh-probe-error when the privacy probe then throws (gate 4 self-skip)', () => {
    const s = section('Repository');
    reportActionsDrift(
      s,
      makeGhRun({
        remote: 'https://github.com/octo/config.git',
        auth: 'probe-error',
        isPrivateThrows: true,
      }),
    );
    // Under a genuine outage the auth-status blip is followed by a privacy-probe
    // throw, which gate 4 silently skips: no spurious WARN.
    expect(s.items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('is silent when the repo is public (gate 4, isRepoPrivate false)', () => {
    const s = section('Repository');
    reportActionsDrift(
      s,
      makeGhRun({ remote: 'https://github.com/octo/config.git', auth: 'ok', isPrivate: false }),
    );
    expect(s.items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('is silent when isRepoPrivate throws (gate 4)', () => {
    const s = section('Repository');
    reportActionsDrift(
      s,
      makeGhRun({
        remote: 'https://github.com/octo/config.git',
        auth: 'ok',
        isPrivateThrows: true,
      }),
    );
    expect(s.items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('is silent when Actions are already disabled (gate 5, actionsEnabled false)', () => {
    const s = section('Repository');
    reportActionsDrift(
      s,
      makeGhRun({
        remote: 'https://github.com/octo/config.git',
        auth: 'ok',
        isPrivate: true,
        actionsEnabled: false,
      }),
    );
    expect(s.items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('is silent when isActionsEnabled throws (gate 5)', () => {
    const s = section('Repository');
    reportActionsDrift(
      s,
      makeGhRun({
        remote: 'https://github.com/octo/config.git',
        auth: 'ok',
        isPrivate: true,
        actionsEnabledThrows: true,
      }),
    );
    expect(s.items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });
});
