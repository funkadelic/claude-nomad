import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * One lexical top-level block of a test file: everything from a line that
 * starts in column 0 up to the next such line. A `describe` block, a shared
 * helper function, and the import preamble are each one region.
 */
type Region = {
  /** The region's full source text. */
  text: string;
  /** True when the region opens a top-level `describe(` / `describe.<mod>(`. */
  isDescribe: boolean;
  /** True when the region opens a FILE-SCOPE `beforeEach`/`afterAll`/etc hook. */
  isFileHook: boolean;
  /** Declared identifier for a top-level `function`/`const` region, else null. */
  name: string | null;
  /** 1-based line number the region starts on, for the failure message. */
  line: number;
  /** The region's first line, for the failure message. */
  head: string;
};

/**
 * A specifier a region passes to `vi.doMock` with nothing in reach to unmock
 * it again.
 */
type Violation = { file: string; region: string; line: number; specifier: string };

/**
 * Collect every string-literal specifier a regex captures out of `source`.
 * Only plain single-quoted literals are recognized, matching this repo's
 * prettier config (`singleQuote: true`); a computed specifier is invisible to
 * this extractor by design, which is what the loud-mismatch check below exists
 * to catch.
 *
 * @param pattern - A capture-group-1 regex, applied globally.
 * @param source - The text to scan.
 * @returns The captured specifiers, in source order (duplicates preserved).
 */
function extract(pattern: RegExp, source: string): string[] {
  return [...source.matchAll(new RegExp(pattern.source, 'g'))].map((match) => match[1]);
}

const MOCK_PATTERN = /vi\.doMock\(\s*'([^']+)'/;
const UNMOCK_PATTERN = /vi\.doUnmock\(\s*'([^']+)'/;

/**
 * Split `source` into top-level regions on column-0 statement boundaries.
 *
 * Prettier's fixed two-space indentation is what makes this reliable without a
 * parser: anything nested inside a `describe` is indented, so a non-blank line
 * starting in column 0 begins a new top-level statement. Closing punctuation
 * (`});`, `];`) is skipped so a block's own terminator does not open a region.
 *
 * @param source - The test file contents.
 * @returns The regions, in source order.
 */
function topLevelRegions(source: string): Region[] {
  const lines = source.split('\n');
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0 || /^\s/.test(line) || /^[})\];]/.test(line)) continue;
    starts.push(i);
  }
  return starts.map((start, i) => {
    const head = lines[start];
    const declared =
      /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(head) ??
      /^(?:export\s+)?const\s+([A-Za-z0-9_$]+)/.exec(head);
    return {
      text: lines.slice(start, starts[i + 1] ?? lines.length).join('\n'),
      isDescribe: /^describe[.(]/.test(head),
      isFileHook: /^(?:before|after)(?:Each|All)\(/.test(head),
      name: declared === null ? null : declared[1],
      line: start + 1,
      head,
    };
  });
}

/**
 * True when `text` reaches `helper`: it names it, and does not shadow the name
 * with its own declaration.
 *
 * `afterEach(teardown)` counts alongside `teardown()`, since passing the helper
 * as the hook body is the same call one frame later. The shadow check is what
 * stops a local of the same name inheriting an unrelated top-level helper's
 * unmocks, which would hand the region a pass it never earned.
 *
 * The identifier is escaped rather than interpolated raw: the name capture
 * admits `$`, which is a regex metacharacter, and an unescaped one silently
 * matches nothing.
 *
 * @param text - The region body to search.
 * @param helper - The named helper region under test.
 * @returns `true` when `text` calls or passes `helper`.
 */
function reaches(text: string, helper: Region): boolean {
  const name = (helper.name ?? '').replace(/[$]/g, '\\$&');
  if (new RegExp(`\\b(?:const|let|var|function)\\s+${name}\\b`).test(text)) return false;
  return new RegExp(`\\b${name}\\s*[(),]`).test(text);
}

/**
 * The transitive closure of named helpers `region` reaches.
 *
 * Iterated to a fixed point because a helper calling a helper is already the
 * live pattern here: one shared setup composes two smaller ones, and only the
 * inner one installs a given mock. Stopping at one level would leave that mock
 * unattributed and the check silently narrower than it reads.
 *
 * @param region - The region whose body starts the walk.
 * @param helpers - Every named helper region in scope, this file's and its
 *   imported test-helper modules'.
 * @returns The helpers `region` reaches, directly or through another helper.
 */
function calledHelpers(region: Region, helpers: Region[]): Region[] {
  const found = new Set<Region>();
  const frontier = [region];
  while (frontier.length > 0) {
    const current = frontier.pop()!;
    for (const helper of helpers) {
      if (found.has(helper) || !reaches(current.text, helper)) continue;
      found.add(helper);
      frontier.push(helper);
    }
  }
  return [...found];
}

/**
 * Report every specifier a `describe` mocks with no matching unmock in reach.
 * Pure: no filesystem access, so it is directly testable with synthetic input.
 *
 * Both halves are resolved over the same scope: a `describe`'s effective mock
 * set is its own body plus the bodies of every helper it reaches (this file's
 * and its imported test-helper modules', transitively) plus the file-scope
 * hooks, and its unmock pool is built from exactly the same regions. Mocks and
 * unmocks therefore flow in together, so a helper that grows a `vi.doMock` is
 * charged to every `describe` that calls it rather than passing unnoticed.
 *
 * A top-level sibling `describe` is in neither set, which is the leak this
 * guard exists to catch: an unmock over there leaves the mock live for every
 * test in between. Two known limits: a NESTED describe is only text inside its
 * parent region, so siblings nested under one parent still pool together, and
 * the unmock is only required to be in scope, not specifically inside an
 * `afterEach`.
 *
 * Regions that are neither a `describe` nor a file-scope hook are not checked
 * on their own. A helper is only ever a leak through the `describe` that calls
 * it, and one that nothing calls installs no mock at runtime.
 *
 * @param file - Basename, for the failure message.
 * @param source - The test file contents.
 * @param imported - Named helper regions from imported test-helper modules.
 * @returns One violation per unreachable specifier, in scan order.
 */
function findViolations(file: string, source: string, imported: Region[]): Violation[] {
  const regions = topLevelRegions(source);
  const helpers = [
    ...regions.filter((r) => !r.isDescribe && !r.isFileHook && r.name !== null),
    ...imported,
  ];
  const fileHooks = regions.filter((r) => r.isFileHook);
  const violations: Violation[] = [];
  for (const region of regions.filter((r) => r.isDescribe)) {
    const scope = [region, ...fileHooks, ...calledHelpers(region, helpers)];
    const mocked = new Set(scope.flatMap((r) => extract(MOCK_PATTERN, r.text)));
    if (mocked.size === 0) continue;
    const pool = new Set(scope.flatMap((r) => extract(UNMOCK_PATTERN, r.text)));
    for (const specifier of mocked) {
      if (!pool.has(specifier)) {
        violations.push({ file, region: region.head.trim(), line: region.line, specifier });
      }
    }
  }
  return violations;
}

/**
 * Count `vi.doMock` call sites in `source` and how many of them open with a
 * plain single-quoted specifier. Both sides use the same paren-to-quote
 * tolerance as {@link MOCK_PATTERN}, so a call prettier wrapped across lines
 * is not miscounted as a computed specifier.
 *
 * @param source - The file contents to scan.
 * @returns The total call count and the literal-specifier count.
 */
function countMockCalls(source: string): { all: number; literal: number } {
  return {
    all: [...source.matchAll(/vi\.doMock\(/g)].length,
    literal: [...source.matchAll(/vi\.doMock\(\s*'/g)].length,
  };
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

/**
 * Every `*.test.ts` vitest runs, excluding this guard itself so its own textual
 * references to the API cannot make it scan its own source.
 *
 * Walked recursively over the same two roots `vitest.config.ts` includes
 * (`src/` and `scripts/`), because a flat `readdirSync` misses a nested test
 * file: it would run in the suite while never entering this scan.
 *
 * Deliberately NOT pre-filtered on the file containing `vi.doMock(`. Several
 * files install their mocks entirely through an imported helper and carry no
 * literal call of their own, and a text filter drops exactly those: the scan
 * goes green while a real leak sits in a file it never opened.
 * `findViolations` returns nothing for a file with no mocks, so the filter
 * bought nothing anyway.
 *
 * @returns Absolute paths to every test file to scan.
 */
function listTestFiles(): string[] {
  const roots = [TEST_DIR, join(TEST_DIR, '..', 'scripts')];
  const found: string[] = [];
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.test.ts')) continue;
      const abs = join(entry.parentPath, entry.name);
      if (abs !== THIS_FILE) found.push(abs);
    }
  }
  return found;
}

/**
 * Paths of the test-helper modules `source` imports, whether they sit beside
 * the importing file or under `test-support/`.
 *
 * @param source - The importing test file's contents.
 * @returns The specifiers as written in the import.
 */
function helperImports(source: string): string[] {
  return [...source.matchAll(/from '(\.[^']+)'/g)]
    .map((match) => match[1])
    .filter((target) => target.includes('test-helper') || target.includes('test-support'));
}

/**
 * Every helper module path reachable from the corpus, resolved against the
 * directory of the file that imports it rather than against one fixed root, so
 * a nested test file's relative specifier still lands on the right file.
 *
 * @param corpus - Absolute path and contents of each scanned test file.
 * @returns Absolute helper paths, deduplicated.
 */
function resolveHelperPaths(corpus: readonly (readonly [string, string])[]): string[] {
  const paths = new Set<string>();
  for (const [file, source] of corpus) {
    for (const target of helperImports(source)) paths.add(join(dirname(file), target));
  }
  return [...paths];
}

/**
 * Read every helper module once, keeping its named top-level regions.
 *
 * Harvesting the whole region, rather than just its unmocks, is what keeps the
 * two halves symmetric across the module boundary. Pulling in only unmocks
 * would hand every describe a free pass for a helper's teardown while never
 * charging it for the setup that installed the mock.
 *
 * A helper that cannot be read is RECORDED rather than skipped quietly. Losing
 * one drops its `vi.doMock` text as well as its `vi.doUnmock` text, so a file
 * that installs every mock through it would then have nothing to report and the
 * guard would pass on exactly the case it exists to cover. The repository-wide
 * check asserts this list is empty.
 *
 * @param paths - Absolute helper module paths.
 * @returns The parsed regions per helper, and the paths that could not be read.
 */
function readHelpers(paths: readonly string[]): {
  regionsByPath: Map<string, Region[]>;
  unreadable: string[];
} {
  const regionsByPath = new Map<string, Region[]>();
  const unreadable: string[] = [];
  for (const path of paths) {
    try {
      const source = readFileSync(path, 'utf8');
      regionsByPath.set(
        path,
        topLevelRegions(source).filter((r) => r.name !== null),
      );
    } catch {
      unreadable.push(path);
    }
  }
  return { regionsByPath, unreadable };
}

describe('findViolations', () => {
  it('reports a specifier unmocked only by a SIBLING describe', () => {
    const source = [
      "describe('a', () => {",
      '  afterEach(() => {});',
      "  it('x', () => {",
      "    vi.doMock('./a.ts');",
      '  });',
      '});',
      "describe('b', () => {",
      '  afterEach(() => {',
      "    vi.doUnmock('./a.ts');",
      '  });',
      '});',
    ].join('\n');
    expect(findViolations('fixture.test.ts', source, [])).toEqual([
      { file: 'fixture.test.ts', region: "describe('a', () => {", line: 1, specifier: './a.ts' },
    ]);
  });

  it('accepts a specifier the same describe unmocks', () => {
    const source = [
      "describe('a', () => {",
      '  afterEach(() => {',
      "    vi.doUnmock('./a.ts');",
      '  });',
      "  it('x', () => {",
      "    vi.doMock('./a.ts');",
      '  });',
      '});',
    ].join('\n');
    expect(findViolations('fixture.test.ts', source, [])).toEqual([]);
  });

  it('accepts a specifier unmocked by a shared teardown helper the describe calls', () => {
    const source = [
      'function teardown() {',
      "  vi.doUnmock('./a.ts');",
      '}',
      "describe('a', () => {",
      '  afterEach(() => {',
      '    teardown();',
      '  });',
      "  it('x', () => {",
      "    vi.doMock('./a.ts');",
      '  });',
      '});',
    ].join('\n');
    expect(findViolations('fixture.test.ts', source, [])).toEqual([]);
  });

  it('rejects a shared teardown helper the describe never calls', () => {
    const source = [
      'function teardown() {',
      "  vi.doUnmock('./a.ts');",
      '}',
      "describe('a', () => {",
      "  it('x', () => {",
      "    vi.doMock('./a.ts');",
      '  });',
      '});',
    ].join('\n');
    expect(findViolations('fixture.test.ts', source, [])).toHaveLength(1);
  });

  it("charges a setup helper's mock to the describe that calls it", () => {
    const source = [
      'function primeMocks() {',
      "  vi.doMock('./a.ts');",
      '}',
      "describe('a', () => {",
      '  beforeEach(() => {',
      '    primeMocks();',
      '  });',
      '});',
    ].join('\n');
    expect(findViolations('fixture.test.ts', source, [])).toHaveLength(1);
  });

  it("clears a setup helper's mock when the same describe unmocks it", () => {
    const source = [
      'function primeMocks() {',
      "  vi.doMock('./a.ts');",
      '}',
      "describe('a', () => {",
      '  beforeEach(() => {',
      '    primeMocks();',
      '  });',
      '  afterEach(() => {',
      "    vi.doUnmock('./a.ts');",
      '  });',
      '});',
    ].join('\n');
    expect(findViolations('fixture.test.ts', source, [])).toEqual([]);
  });

  it('ignores a helper no describe calls, which installs no mock at runtime', () => {
    const source = ['function primeMocks() {', "  vi.doMock('./a.ts');", '}'].join('\n');
    expect(findViolations('fixture.test.ts', source, [])).toEqual([]);
  });

  it('follows a helper that calls another helper', () => {
    const source = [
      'function inner() {',
      "  vi.doMock('./a.ts');",
      '}',
      'function outer() {',
      '  inner();',
      '}',
      "describe('a', () => {",
      '  beforeEach(() => {',
      '    outer();',
      '  });',
      '});',
    ].join('\n');
    expect(findViolations('fixture.test.ts', source, [])).toHaveLength(1);
  });

  it('counts a helper passed to a hook as a value, not just one called', () => {
    const source = [
      'function teardown() {',
      "  vi.doUnmock('./a.ts');",
      '}',
      "describe('a', () => {",
      '  afterEach(teardown);',
      "  vi.doMock('./a.ts');",
      '});',
    ].join('\n');
    expect(findViolations('fixture.test.ts', source, [])).toEqual([]);
  });

  it('does not credit a top-level helper the describe shadows with its own local', () => {
    const source = [
      'function teardown() {',
      "  vi.doUnmock('./a.ts');",
      '}',
      "describe('a', () => {",
      '  const teardown = () => {};',
      '  afterEach(() => teardown());',
      "  vi.doMock('./a.ts');",
      '});',
    ].join('\n');
    expect(findViolations('fixture.test.ts', source, [])).toHaveLength(1);
  });

  it('applies a file-scope afterEach to every describe', () => {
    const source = [
      'afterEach(() => {',
      "  vi.doUnmock('./a.ts');",
      '});',
      "describe('a', () => {",
      "  vi.doMock('./a.ts');",
      '});',
    ].join('\n');
    expect(findViolations('fixture.test.ts', source, [])).toEqual([]);
  });

  it('charges a file-scope beforeEach mock to every describe', () => {
    const source = [
      'beforeEach(() => {',
      "  vi.doMock('./a.ts');",
      '});',
      "describe('a', () => {",
      '});',
    ].join('\n');
    expect(findViolations('fixture.test.ts', source, [])).toHaveLength(1);
  });

  it('resolves both halves through an imported helper module region', () => {
    const source = ["describe('a', () => {", '  setUp();', '  tearDown();', '});'].join('\n');
    const imported = topLevelRegions(
      [
        'export function setUp() {',
        "  vi.doMock('./a.ts');",
        "  vi.doMock('./b.ts');",
        '}',
        'export function tearDown() {',
        "  vi.doUnmock('./a.ts');",
        '}',
      ].join('\n'),
    ).filter((r) => r.name !== null);
    // './a.ts' is paired across the module boundary; './b.ts' is charged to the
    // describe even though the mock is written in the helper, not in the file.
    expect(findViolations('fixture.test.ts', source, imported)).toEqual([
      { file: 'fixture.test.ts', region: "describe('a', () => {", line: 1, specifier: './b.ts' },
    ]);
  });
});

/** Absolute path and contents of every scanned test file, read once. */
const CORPUS: readonly (readonly [string, string])[] = listTestFiles().map((file) => [
  file,
  readFileSync(file, 'utf8'),
]);

/** Named top-level regions of every helper module the corpus imports, read once. */
const HELPERS = readHelpers(resolveHelperPaths(CORPUS));

/** Path shown in a failure message: relative to `src/`, so it stays readable. */
function label(file: string): string {
  return relative(TEST_DIR, file);
}

/** The helper regions reachable from one test file. */
function helpersFor(source: string, file: string): Region[] {
  return helperImports(source).flatMap(
    (target) => HELPERS.regionsByPath.get(join(dirname(file), target)) ?? [],
  );
}

describe('doMock/doUnmock symmetry across every test file', () => {
  it('every describe can reach a vi.doUnmock for what it vi.doMocks', () => {
    // A discovery failure (an empty scan) must not read as a pass.
    expect(CORPUS.length).toBeGreaterThan(0);
    // Nor may a helper this guard cannot read. Dropping one takes its doMock
    // text with its doUnmock text, so a file that installs every mock through
    // that helper would report nothing and the scan would go green.
    expect(HELPERS.unreadable.map(label)).toEqual([]);
    const violations: Violation[] = [];
    let attributed = 0;
    for (const [file, source] of CORPUS) {
      violations.push(...findViolations(label(file), source, helpersFor(source, file)));
      attributed += extract(MOCK_PATTERN, source).length;
    }
    for (const regions of HELPERS.regionsByPath.values()) {
      for (const region of regions) attributed += extract(MOCK_PATTERN, region.text).length;
    }
    // Discovery is not the only way this check can fail open: if MOCK_PATTERN
    // ever stops matching, every file is visited, nothing is attributed, and
    // the scan reports green. Counted through the same pattern the check uses,
    // over helper modules as well, so moving mocks into a helper does not drift
    // the number toward the floor. The real tree carries hundreds.
    expect(attributed).toBeGreaterThan(100);
    if (violations.length > 0) {
      const detail = violations
        .map(
          (v) => `  ${v.file}:${v.line} ${v.region}\n    mocks '${v.specifier}', never unmocks it`,
        )
        .join('\n');
      throw new Error(
        `doMock/doUnmock asymmetry:\n${detail}\n` +
          "Remedy: add the missing vi.doUnmock to THIS describe's own afterEach, or to a " +
          'shared teardown helper it calls. An unmock in a sibling describe does not count: ' +
          'the mock stays live for every test in between.',
      );
    }
  });

  it('every vi.doMock call site uses a plain single-quoted specifier', () => {
    // Helper modules are checked too: they are where a mock most easily hides
    // from the scan above, since the file that calls one carries no doMock text.
    const sources: (readonly [string, string])[] = [
      ...CORPUS,
      ...[...HELPERS.regionsByPath].map(
        ([path, regions]) => [path, regions.map((r) => r.text).join('\n')] as const,
      ),
    ];
    for (const [file, source] of sources) {
      const { all, literal } = countMockCalls(source);
      expect(
        all,
        `${label(file)} has ${all} vi.doMock( call site(s) but only ${literal} use a plain ` +
          'single-quoted specifier; a computed or non-literal specifier is invisible to the ' +
          'symmetry guard above',
      ).toBe(literal);
    }
  });
});
