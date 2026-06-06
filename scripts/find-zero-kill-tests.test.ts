import { describe, expect, it } from 'vitest';

import { findZeroKillTests } from './find-zero-kill-tests.mjs';

/**
 * Minimal Stryker mutation-report fixture builder. Produces only the fields
 * that `findZeroKillTests` reads so tests stay small and focused on behavior.
 */
function makeReport(opts: {
  files?: Record<string, { mutants: Record<string, { killedBy?: string[] }> }>;
  testFiles?: Record<string, { tests: { id: string; name: string }[] }>;
}): Parameters<typeof findZeroKillTests>[0] {
  return opts as Parameters<typeof findZeroKillTests>[0];
}

describe('findZeroKillTests (scripts/find-zero-kill-tests.mjs)', () => {
  it('returns a test absent from all killedBy arrays as a zero-kill candidate', () => {
    const report = makeReport({
      files: {
        'src/foo.ts': {
          mutants: {
            '0': { killedBy: ['test-A'] },
          },
        },
      },
      testFiles: {
        'src/foo.test.ts': {
          tests: [
            { id: 'test-A', name: 'foo does something' },
            { id: 'test-B', name: 'foo does nothing' },
          ],
        },
      },
    });

    const result = findZeroKillTests(report);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      file: 'src/foo.test.ts',
      id: 'test-B',
      name: 'foo does nothing',
    });
  });

  it('excludes a test that appears in at least one killedBy array', () => {
    const report = makeReport({
      files: {
        'src/bar.ts': {
          mutants: {
            '0': { killedBy: ['test-X', 'test-Y'] },
            '1': { killedBy: ['test-X'] },
          },
        },
      },
      testFiles: {
        'src/bar.test.ts': {
          tests: [
            { id: 'test-X', name: 'bar kills mutants' },
            { id: 'test-Y', name: 'bar also kills' },
          ],
        },
      },
    });

    const result = findZeroKillTests(report);

    expect(result).toHaveLength(0);
  });

  it('returns empty array without throwing when files, testFiles, mutants, or killedBy are missing', () => {
    expect(findZeroKillTests({})).toEqual([]);
    expect(findZeroKillTests({ files: {} })).toEqual([]);
    expect(findZeroKillTests({ testFiles: {} })).toEqual([]);
    expect(
      findZeroKillTests({
        files: { 'src/x.ts': { mutants: { '0': {} } } },
        testFiles: { 'src/x.test.ts': { tests: [{ id: 't0', name: 'empty killedBy' }] } },
      }),
    ).toEqual([{ file: 'src/x.test.ts', id: 't0', name: 'empty killedBy' }]);
  });

  it('aggregates killers across multiple files and mutants', () => {
    const report = makeReport({
      files: {
        'src/a.ts': {
          mutants: {
            '0': { killedBy: ['t1'] },
          },
        },
        'src/b.ts': {
          mutants: {
            '0': { killedBy: ['t2'] },
          },
        },
      },
      testFiles: {
        'src/a.test.ts': {
          tests: [
            { id: 't1', name: 'a kills' },
            { id: 't3', name: 'a zero-kill' },
          ],
        },
        'src/b.test.ts': {
          tests: [
            { id: 't2', name: 'b kills' },
            { id: 't4', name: 'b zero-kill' },
          ],
        },
      },
    });

    const result = findZeroKillTests(report);

    expect(result).toHaveLength(2);
    const ids = result.map((c) => c.id).sort();
    expect(ids).toEqual(['t3', 't4']);
  });

  it('excludes a test killed by a mutant in a DIFFERENT source file (killers are global)', () => {
    const report = makeReport({
      files: {
        'src/c.ts': {
          mutants: {
            '0': { killedBy: ['t-in-d-test'] },
          },
        },
        'src/d.ts': {
          mutants: {
            '0': { killedBy: ['t-in-c-test'] },
          },
        },
      },
      testFiles: {
        'src/c.test.ts': {
          tests: [{ id: 't-in-c-test', name: 'c test kills d mutant' }],
        },
        'src/d.test.ts': {
          tests: [{ id: 't-in-d-test', name: 'd test kills c mutant' }],
        },
      },
    });

    const result = findZeroKillTests(report);

    // Both tests kill mutants in the OTHER file; neither is a zero-kill candidate.
    expect(result).toHaveLength(0);
  });
});
