import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { okGlyph, warnGlyph } from '../../../color.ts';
import { section } from '../format.ts';
import { reportCrlfGuardCheck } from './crlf.ts';
import type { SpawnSyncFn } from '../../init/gh-actions.ts';
import { stubPlatform } from '../../../test-helpers.platform.ts';

// win32 stub helper: overrides process.platform for the current test, restored
// in afterEach. NO_COLOR=1 is set so glyph substring asserts are not split by
// ANSI escapes (picocolors forces color ON for win32 regardless of TTY).
const realPlatform = process.platform;

describe('reportCrlfGuardCheck', () => {
  let originalNoColor: string | undefined;
  let originalNomadRepo: string | undefined;
  let savedExitCode: typeof process.exitCode;
  let testRepo: string;

  beforeEach(() => {
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    originalNomadRepo = process.env.NOMAD_REPO;
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    testRepo = mkdtempSync(join(tmpdir(), 'nomad-crlf-'));
    process.env.NOMAD_REPO = testRepo;
  });

  afterEach(() => {
    stubPlatform(realPlatform);
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    if (originalNomadRepo === undefined) delete process.env.NOMAD_REPO;
    else process.env.NOMAD_REPO = originalNomadRepo;
    process.exitCode = savedExitCode;
    rmSync(testRepo, { recursive: true, force: true });
  });

  it('emits an OK row when .gitattributes carries a `* -text` guard line, without probing git', () => {
    writeFileSync(join(testRepo, '.gitattributes'), '# comment\n* -text\n');
    const calls: string[][] = [];
    const run: SpawnSyncFn = (bin, args) => {
      calls.push([bin, ...args]);
      throw new Error('run must not be called when the guard is present');
    };
    const s = section('Environment');
    reportCrlfGuardCheck(s, run);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(okGlyph);
    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits a WARN row conveying active conversion when the guard is absent and autocrlf is true', () => {
    const run: SpawnSyncFn = () => Buffer.from('true\n');
    const s = section('Environment');
    reportCrlfGuardCheck(s, run);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(warnGlyph);
    expect(s.items[0]).toContain('actively converting');
    expect(s.items[0]).toContain('.gitattributes');
    expect(process.exitCode).toBeUndefined();
  });

  it('emits a WARN row conveying active conversion when autocrlf is input', () => {
    const run: SpawnSyncFn = () => Buffer.from('input\n');
    const s = section('Environment');
    reportCrlfGuardCheck(s, run);
    expect(s.items[0]).toContain(warnGlyph);
    expect(s.items[0]).toContain('actively converting');
  });

  it('emits a WARN row conveying explicit-disabled guarding when autocrlf is false, without saying unset', () => {
    const run: SpawnSyncFn = () => Buffer.from('false\n');
    const s = section('Environment');
    reportCrlfGuardCheck(s, run);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(warnGlyph);
    expect(s.items[0]).toContain('core.autocrlf=false');
    expect(s.items[0]).not.toContain('unset');
    expect(process.exitCode).toBeUndefined();
  });

  it('emits a WARN row conveying latent risk when the probe returns a value other than true/input/false', () => {
    const run: SpawnSyncFn = () => Buffer.from('garbage\n');
    const s = section('Environment');
    reportCrlfGuardCheck(s, run);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(warnGlyph);
    expect(s.items[0]).toContain('latent risk');
  });

  it('emits a WARN row conveying latent risk when the guard is absent and the config probe throws', () => {
    const run: SpawnSyncFn = () => {
      throw Object.assign(new Error('exit 1'), { code: 1 });
    };
    const s = section('Environment');
    expect(() => reportCrlfGuardCheck(s, run)).not.toThrow();
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(warnGlyph);
    expect(s.items[0]).toContain('latent risk');
    expect(process.exitCode).toBeUndefined();
  });

  it('emits a WARN row when .gitattributes exists but has no `* -text` line', () => {
    writeFileSync(join(testRepo, '.gitattributes'), '*.png binary\n');
    const run: SpawnSyncFn = () => {
      throw Object.assign(new Error('exit 1'), { code: 1 });
    };
    const s = section('Environment');
    reportCrlfGuardCheck(s, run);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(warnGlyph);
  });

  it('runs on a darwin stub (no process.platform gate)', () => {
    stubPlatform('darwin');
    const run: SpawnSyncFn = () => Buffer.from('true\n');
    const s = section('Environment');
    reportCrlfGuardCheck(s, run);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('leaves process.exitCode unchanged across every arm', () => {
    const arms: SpawnSyncFn[] = [
      () => Buffer.from('true\n'),
      () => Buffer.from('input\n'),
      () => Buffer.from('false\n'),
      () => {
        throw new Error('unset');
      },
    ];
    for (const run of arms) {
      process.exitCode = undefined;
      const s = section('Environment');
      reportCrlfGuardCheck(s, run);
      expect(process.exitCode).toBeUndefined();
    }
  });

  it('treats an unreadable .gitattributes (e.g. a directory at that path) as guard-absent', () => {
    mkdirSync(join(testRepo, '.gitattributes'), { recursive: true });
    const run: SpawnSyncFn = () => {
      throw Object.assign(new Error('exit 1'), { code: 1 });
    };
    const s = section('Environment');
    expect(() => reportCrlfGuardCheck(s, run)).not.toThrow();
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(warnGlyph);
  });

  it('does not throw when REPO_HOME itself does not exist', () => {
    rmSync(testRepo, { recursive: true, force: true });
    mkdirSync(testRepo, { recursive: true }); // afterEach expects it to exist
    process.env.NOMAD_REPO = join(testRepo, 'missing-repo');
    const run: SpawnSyncFn = () => {
      throw Object.assign(new Error('exit 1'), { code: 1 });
    };
    const s = section('Environment');
    expect(() => reportCrlfGuardCheck(s, run)).not.toThrow();
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(warnGlyph);
  });
});
