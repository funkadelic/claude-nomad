import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * A single teardown-drift violation: a module specifier that a push-cluster
 * test file passes to `vi.doMock` with no matching `vi.doUnmock` entry in
 * `teardownPushEnv`.
 */
type Violation = { file: string; specifier: string };

/**
 * Compare every mocked specifier in `mocksByFile` against `unmockList` and
 * return one violation per specifier that has no matching teardown entry.
 * Pure: no filesystem or module-graph access, so it is directly testable
 * with synthetic input.
 *
 * @param unmockList - The specifiers `teardownPushEnv` unmocks.
 * @param mocksByFile - Each scanned test file mapped to the specifiers it
 *   passes to `vi.doMock`.
 * @returns One `{file, specifier}` entry per specifier missing from
 *   `unmockList`, in file/specifier scan order.
 */
function findViolations(unmockList: Set<string>, mocksByFile: Map<string, string[]>): Violation[] {
  const violations: Violation[] = [];
  for (const [file, specifiers] of mocksByFile) {
    for (const specifier of specifiers) {
      if (!unmockList.has(specifier)) {
        violations.push({ file, specifier });
      }
    }
  }
  return violations;
}

/**
 * Extract every string-literal specifier passed to `vi.doUnmock(...)` in
 * `source`. Only plain single-quoted literals are recognized, matching this
 * repo's prettier config (`singleQuote: true`); a non-literal specifier is
 * invisible to this extractor by design, which is why the loud-mismatch
 * check below exists as a separate guard.
 *
 * @param source - The file contents to scan.
 * @returns The specifiers found, in source order (duplicates preserved).
 */
function extractDoUnmockSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /vi\.doUnmock\(\s*'([^']+)'\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * Extract every string-literal specifier passed to `vi.doMock(...)` in
 * `source`, mirroring `extractDoUnmockSpecifiers`'s single-quote-only
 * matching.
 *
 * @param source - The file contents to scan.
 * @returns The specifiers found, in source order (duplicates preserved).
 */
function extractDoMockSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /vi\.doMock\(\s*'([^']+)'/g;
  for (const match of source.matchAll(pattern)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * Count non-overlapping occurrences of a literal substring in `source`.
 *
 * @param source - The file contents to scan.
 * @param needle - The literal substring to count.
 * @returns The number of occurrences.
 */
function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const THIS_FILE = basename(fileURLToPath(import.meta.url));
const HELPER_BASENAME = 'commands.push.test-helpers.ts';
const CLUSTER_NAME_PATTERN = /^commands\.push.*\.test\.ts$/;

/**
 * List every `commands.push*.test.ts` file in this directory that imports
 * the shared `commands.push.test-helpers.ts` harness, excluding this guard
 * file itself so its own textual reference to the helper's import path
 * cannot make it scan itself. Discovery is directory-driven (not a
 * hardcoded file list) so a newly added cluster test file is picked up
 * automatically.
 *
 * @returns The matching basenames, in `readdirSync` order.
 */
function listClusterFiles(): string[] {
  return readdirSync(TEST_DIR).filter((name) => {
    if (name === THIS_FILE) return false;
    if (!CLUSTER_NAME_PATTERN.test(name)) return false;
    const source = readFileSync(join(TEST_DIR, name), 'utf8');
    return source.includes(`from './${HELPER_BASENAME}'`);
  });
}

describe('findViolations', () => {
  it('reports a specifier that has no matching unmock entry', () => {
    const unmockList = new Set(['./a.ts']);
    const mocksByFile = new Map([['fixture.test.ts', ['./a.ts', './b.ts']]]);
    expect(findViolations(unmockList, mocksByFile)).toEqual([
      { file: 'fixture.test.ts', specifier: './b.ts' },
    ]);
  });

  it('reports nothing when every specifier has a matching unmock entry', () => {
    const unmockList = new Set(['./a.ts', './b.ts']);
    const mocksByFile = new Map([['fixture.test.ts', ['./a.ts', './b.ts']]]);
    expect(findViolations(unmockList, mocksByFile)).toEqual([]);
  });
});

describe('push-cluster doMock/doUnmock symmetry', () => {
  it('teardownPushEnv unmocks every specifier the cluster mocks', () => {
    const helperSource = readFileSync(join(TEST_DIR, HELPER_BASENAME), 'utf8');
    const unmockList = new Set(extractDoUnmockSpecifiers(helperSource));
    const files = listClusterFiles();
    // A discovery failure (e.g. a rename that breaks the import match)
    // must not silently pass an empty scan.
    expect(files.length).toBeGreaterThan(0);
    const mocksByFile = new Map<string, string[]>();
    for (const file of files) {
      const source = readFileSync(join(TEST_DIR, file), 'utf8');
      mocksByFile.set(file, extractDoMockSpecifiers(source));
    }
    const violations = findViolations(unmockList, mocksByFile);
    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  ${v.file}: '${v.specifier}' has no matching vi.doUnmock in teardownPushEnv`)
        .join('\n');
      throw new Error(
        `push-cluster mock/unmock asymmetry:\n${detail}\n` +
          `Remedy: add the missing specifier to teardownPushEnv's vi.doUnmock block in ${HELPER_BASENAME}.`,
      );
    }
  });

  it('every vi.doMock call site in the cluster uses a plain single-quoted specifier', () => {
    const files = listClusterFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(TEST_DIR, file), 'utf8');
      const allCalls = countOccurrences(source, 'vi.doMock(');
      const literalCalls = countOccurrences(source, "vi.doMock('");
      expect(
        allCalls,
        `${file} has ${allCalls} vi.doMock( call site(s) but only ${literalCalls} use a plain ` +
          'single-quoted specifier; a computed or non-literal specifier is invisible to the ' +
          'symmetry guard above',
      ).toBe(literalCalls);
    }
  });
});
