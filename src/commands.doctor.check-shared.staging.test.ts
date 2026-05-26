import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as cpModule from 'node:child_process';

import { failGlyph, okGlyph } from './color.ts';
import {
  type EnvSnapshot,
  type Section,
  makeEnv,
  restoreEnv,
  saveEnv,
} from './commands.doctor.check-shared.test-helpers.ts';

/**
 * `buildScanTree` staging guards that short-circuit to a clean "0 project(s)"
 * row BEFORE the scan runs (no real gitleaks needed): no `path-map.json`, a
 * non-object `projects`, and a non-object host map. Each asserts the scan is
 * never invoked. Every `vi.doMock` here is paired with a `vi.doUnmock` in
 * `afterEach` because `vi.restoreAllMocks` does NOT clear `vi.doMock` module
 * mocks (they would otherwise leak across files).
 */
describe('reportCheckShared (staging guards -> clean zero)', () => {
  let snapshot: EnvSnapshot;
  let testHome: string;

  beforeEach(() => {
    snapshot = saveEnv();
  });

  afterEach(() => {
    vi.doUnmock('node:child_process');
    restoreEnv(snapshot, testHome);
  });

  it('reports clean with zero scanned when no path-map.json exists', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    // No path-map.json written: buildScanTree finds nothing to stage, so the
    // reporter short-circuits to a clean "0 project(s)" row without scanning.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          if ((args ?? [])[0] === 'version') return Buffer.from('8.0.0');
          throw new Error('scan must not run when nothing is staged');
        }),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    expect(section.items.some((r) => r.includes(okGlyph) && r.includes('0 project'))).toBe(true);
    expect(section.items.some((r) => r.includes(failGlyph))).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  it('reports clean with zero scanned when path-map projects is not an object', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    // A structurally valid JSON whose `projects` is a non-object: buildScanTree
    // treats it as empty (no crash) and the reporter emits a clean 0 row.
    writeFileSync(
      join(testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: 'nope' }) + '\n',
    );
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) =>
          (args ?? [])[0] === 'version' ? Buffer.from('8.0.0') : Buffer.from(''),
        ),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    expect(section.items.some((r) => r.includes(okGlyph) && r.includes('0 project'))).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it('skips a project whose host map is not an object and reports clean zero', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    // `projects.foo` is a string, not a { host: path } object: buildScanTree
    // skips it (continue) rather than throwing, leaving nothing staged.
    writeFileSync(
      join(testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: { foo: 'not-an-object' } }) + '\n',
    );
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) =>
          (args ?? [])[0] === 'version' ? Buffer.from('8.0.0') : Buffer.from(''),
        ),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    expect(section.items.some((r) => r.includes(okGlyph) && r.includes('0 project'))).toBe(true);
    expect(process.exitCode).toBe(0);
  });
});
