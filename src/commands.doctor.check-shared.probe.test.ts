import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as cpModule from 'node:child_process';

import { failGlyph, okGlyph, warnGlyph } from './color.ts';
import {
  type EnvSnapshot,
  type Section,
  makeEnv,
  PLANTED_SECRET,
  restoreEnv,
  saveEnv,
  writePathMap,
} from './commands.doctor.check-shared.test-helpers.ts';

/**
 * gitleaks probe-readiness ladder + the malformed-path-map degradation (no real
 * gitleaks needed): D-09 ENOENT WARN-skip, EACCES FAIL, and a malformed
 * `path-map.json` FAIL-without-throw. The clean-zero staging guards live in the
 * `.staging.test.ts` sibling. Every `vi.doMock` here is paired with a
 * `vi.doUnmock` in `afterEach` because `vi.restoreAllMocks` does NOT clear
 * `vi.doMock` module mocks (they would otherwise leak across files).
 */
describe('reportCheckShared (probe ladder + malformed map)', () => {
  let snapshot: EnvSnapshot;
  let testHome: string;

  beforeEach(() => {
    snapshot = saveEnv();
  });

  afterEach(() => {
    // Pair every doMock with a doUnmock; restoreAllMocks does NOT clear doMock
    // module mocks, so an unpaired mock would leak into later files.
    vi.doUnmock('node:child_process');
    restoreEnv(snapshot, testHome);
  });

  it('emits exactly one warn row and leaves exitCode 0 when the gitleaks probe throws ENOENT (D-09)', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    // A planted secret + valid map would normally fail; the missing-binary
    // probe must short-circuit BEFORE any scan, so the leak is never reached.
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-no-gitleaks.jsonl'),
      `{"role":"user","text":"${PLANTED_SECRET}"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        // probeGitleaks calls execFileSync('gitleaks', ['version', ...]); throw
        // an ENOENT-coded error to simulate the binary being absent from PATH.
        execFileSync: vi.fn(() => {
          throw Object.assign(new Error('spawn gitleaks ENOENT'), { code: 'ENOENT' });
        }),
      };
    });

    expect(process.exitCode).toBe(0);
    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const warnRows = section.items.filter((r) => r.includes(warnGlyph));
    expect(warnRows.length).toBe(1);
    expect(warnRows[0]).toMatch(/skip/i);
    expect(section.items.some((r) => r.includes(failGlyph))).toBe(false);
    expect(section.items.some((r) => r.includes(okGlyph))).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  it('emits a probe-failed FAIL row (not a not-on-PATH skip) when the gitleaks probe fails with EACCES', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-eacces.jsonl'),
      `{"role":"user","text":"benign"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        // A permission error (corrupt binary / bad perms), NOT ENOENT. The
        // reporter must distinguish this from missing-on-PATH (which is a WARN
        // skip) and report a FAIL with the underlying message, mirroring
        // reportGitleaksProbe.
        execFileSync: vi.fn(() => {
          throw Object.assign(new Error('spawn gitleaks EACCES'), { code: 'EACCES' });
        }),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const rows = section.items.join('\n');
    expect(section.items.some((r) => r.includes(failGlyph))).toBe(true);
    expect(section.items.some((r) => r.includes(warnGlyph))).toBe(false);
    expect(rows).toMatch(/EACCES/);
    expect(process.exitCode).toBe(1);
  });

  it('degrades a malformed path-map.json to a FAIL row and exit 1 without throwing', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    // A malformed path-map.json: readJson (raw JSON.parse) would throw a
    // SyntaxError. The reporter must catch it, emit a FAIL row, and set
    // exitCode 1 rather than letting the error propagate and abort doctor.
    writeFileSync(join(testHome, 'claude-nomad', 'path-map.json'), '{ this is not valid json');

    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        // The version probe must succeed so the flow reaches the path-map read.
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          const list = args ?? [];
          if (list[0] === 'version') return Buffer.from('8.0.0');
          return Buffer.from('');
        }),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    expect(() => {
      reportCheckShared(section);
    }).not.toThrow();

    expect(section.items.some((r) => r.includes(failGlyph))).toBe(true);
    expect(section.items.some((r) => r.includes(okGlyph))).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});
