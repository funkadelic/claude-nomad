import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { okGlyph, warnGlyph } from '../../../color.ts';
import { repoHome } from '../../../config.ts';
import { section } from '../format.ts';
import { reportLongPathsCheck, reportSyncModality } from './longpaths.ts';
import type { SpawnSyncFn } from '../../init/gh-actions.ts';
import { stubPlatform } from '../../../test-helpers.platform.ts';

// win32 stub helper: overrides process.platform for the current test, restored
// in afterEach. NO_COLOR=1 is set so glyph substring asserts are not split by
// ANSI escapes (picocolors forces color ON for win32 regardless of TTY).
const realPlatform = process.platform;

/**
 * Build a SpawnSyncFn that returns enabled output for both `git config` and
 * `reg query`, and records every invocation for call-count assertions.
 *
 * @param calls - Array pushed to on every invocation (bin + args).
 */
function runBothEnabled(calls: string[][]): SpawnSyncFn {
  return (bin, args) => {
    calls.push([bin, ...args]);
    if (bin === 'git') return Buffer.from('true\n');
    if (bin === 'reg') {
      return Buffer.from('    LongPathsEnabled    REG_DWORD    0x1\n');
    }
    throw Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' });
  };
}

describe('reportLongPathsCheck', () => {
  let originalNoColor: string | undefined;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    stubPlatform(realPlatform);
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    process.exitCode = savedExitCode;
  });

  it('emits two OK rows on win32 when both git core.longpaths and the registry are enabled', () => {
    stubPlatform('win32');
    const calls: string[][] = [];
    const s = section('Environment');
    reportLongPathsCheck(s, runBothEnabled(calls));
    expect(s.items).toHaveLength(2);
    const gitRow = s.items.find((item) => item.includes('core.longpaths'));
    const regRow = s.items.find((item) => item.includes('OS long paths'));
    expect(gitRow).toBeDefined();
    expect(gitRow).toContain(okGlyph);
    expect(regRow).toBeDefined();
    expect(regRow).toContain(okGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('scopes the git config probe to -C repoHome() so it reads the sync repo, not cwd', () => {
    stubPlatform('win32');
    const calls: string[][] = [];
    const s = section('Environment');
    reportLongPathsCheck(s, runBothEnabled(calls));
    const gitCall = calls.find((c) => c[0] === 'git');
    expect(gitCall).toEqual(['git', '-C', repoHome(), 'config', '--get', 'core.longpaths']);
  });

  it('accepts a trimmed "1" as enabled for git core.longpaths (not only "true")', () => {
    stubPlatform('win32');
    const run: SpawnSyncFn = (bin) => {
      if (bin === 'git') return Buffer.from('1\n');
      return Buffer.from('    LongPathsEnabled    REG_DWORD    0x1\n');
    };
    const s = section('Environment');
    reportLongPathsCheck(s, run);
    const gitRow = s.items.find((item) => item.includes('core.longpaths'));
    expect(gitRow).toContain(okGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits WARN rows on win32 when git core.longpaths is unset and the registry value is 0x0', () => {
    stubPlatform('win32');
    const run: SpawnSyncFn = (bin) => {
      if (bin === 'git') {
        // `git config --get` exits non-zero when the key is unset.
        throw Object.assign(new Error('exit 1'), { code: 1 });
      }
      if (bin === 'reg') {
        return Buffer.from('    LongPathsEnabled    REG_DWORD    0x0\n');
      }
      throw Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' });
    };
    const s = section('Environment');
    reportLongPathsCheck(s, run);
    expect(s.items).toHaveLength(2);
    const gitRow = s.items.find((item) => item.includes('core.longpaths'));
    const regRow = s.items.find((item) => item.includes('OS long paths'));
    expect(gitRow).toContain(warnGlyph);
    expect(regRow).toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('degrades to a WARN row on win32 when the reg query throws ENOENT (reg.exe absent)', () => {
    stubPlatform('win32');
    const run: SpawnSyncFn = (bin) => {
      if (bin === 'git') return Buffer.from('true\n');
      throw Object.assign(new Error('spawn reg ENOENT'), { code: 'ENOENT' });
    };
    const s = section('Environment');
    expect(() => reportLongPathsCheck(s, run)).not.toThrow();
    expect(s.items).toHaveLength(2);
    const regRow = s.items.find((item) => item.includes('OS long paths'));
    expect(regRow).toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('is a zero-row, zero-spawn no-op on darwin', () => {
    stubPlatform('darwin');
    const calls: string[][] = [];
    const run: SpawnSyncFn = (bin, args) => {
      calls.push([bin, ...args]);
      return Buffer.from('true\n');
    };
    const s = section('Environment');
    reportLongPathsCheck(s, run);
    expect(s.items).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });
});

describe('reportSyncModality', () => {
  afterEach(() => {
    stubPlatform(realPlatform);
  });

  it('emits an informational row conveying copy-sync on win32', () => {
    stubPlatform('win32');
    const s = section('Environment');
    reportSyncModality(s);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain('copy-sync');
  });

  it('names when an edit reaches the repo on win32, where the two files are distinct', () => {
    stubPlatform('win32');
    const s = section('Environment');
    reportSyncModality(s);
    expect(s.items[0]).toContain('next pull or push');
  });

  it('omits that note on posix, where the symlink makes an edit live immediately', () => {
    stubPlatform('linux');
    const s = section('Environment');
    reportSyncModality(s);
    expect(s.items[0]).not.toContain('next pull or push');
  });

  it('emits an informational row conveying symlink on a non-win32 platform', () => {
    stubPlatform('darwin');
    const s = section('Environment');
    reportSyncModality(s);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain('symlink');
  });
});
