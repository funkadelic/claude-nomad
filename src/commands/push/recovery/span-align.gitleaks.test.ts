import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderFindingBlock } from './display.ts';
import { scanStagedTree, type Finding } from '../gitleaks.scan.ts';

/**
 * Real-binary regression suite for the gitleaks column offset.
 *
 * `gitleaks protect --staged` reports `StartColumn`/`EndColumn` one HIGHER than
 * the true byte position for any finding after the first line of a file, so a
 * span sliced at the reported column dropped the secret's first character and
 * picked up a stray trailing one. The whole recovery prompt is built from that
 * span, so a 40-character token rendered as `39 chars` with a truncated head
 * fragment, and the label line gained a doubled character at the seam.
 *
 * Every fixture below puts its secret after line 1, which is the shape every
 * real session transcript has, and drives the REAL renderer
 * (`renderFindingBlock`) over the REAL report rather than a hand-built
 * `Finding`. A hand-built fixture is what let this ship: the unit suite was
 * green because every fixture was ASCII, single-line, and column-correct.
 *
 * Hermetic `HOME`/`REPO_HOME` with a copy of the worktree `.gitleaks.toml`,
 * mirroring `commands/push/gitleaks-skills-allowlist.test.ts`, so the scan loads the
 * production allowlist regardless of the developer machine's real
 * `~/claude-nomad/` state. Gated on the real gitleaks binary so a host without
 * it still runs the rest of the suite.
 */
const hasGitleaks = ((): boolean => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Assemble a github-pat-shaped fixture token from fragments so no contiguous
 * `ghp_<36>` literal is stored in source-controlled bytes, which this repo's
 * own gitleaks CI check would flag. Same convention as
 * `commands/push/gitleaks-skills-allowlist.test.ts`.
 *
 * @param body The 36-char token body that follows the `ghp_` prefix.
 * @returns A `ghp_`-prefixed token assembled at runtime.
 */
const ghpFixture = (body: string): string => ['gh', 'p_', body].join('');

/** A high-entropy PAT fixture: deterministic, and not one of the allowlisted literals. */
const PAT = ghpFixture('R7q2Ld9Xv4Kc1Ns8Bt6Hm3Zw0Yf5Pj7Gr2Qa');

describe.skipIf(!hasGitleaks)('push recovery span alignment (real gitleaks)', () => {
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let scanRoot: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-span-align-home-'));
    const repoUnderHome = join(testHome, 'claude-nomad');
    mkdirSync(repoUnderHome, { recursive: true });
    const here = dirname(fileURLToPath(import.meta.url));
    copyFileSync(
      join(here, '..', '..', '..', '..', '.gitleaks.toml'),
      join(repoUnderHome, '.gitleaks.toml'),
    );
    process.env.HOME = testHome;
    delete process.env.NOMAD_REPO;
    scanRoot = mkdtempSync(join(tmpdir(), 'nomad-span-align-scan-'));
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testHome, { recursive: true, force: true });
    rmSync(scanRoot, { recursive: true, force: true });
  });

  /** Write a file under the scan root, creating parent directories. */
  function write(relPath: string, body: string): void {
    const filePath = join(scanRoot, relPath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, body);
  }

  /** Read the 1-indexed line of a scanned file, the same seam `collectActions` builds. */
  function readLine(file: string, line: number): string | null {
    return readFileSync(join(scanRoot, file), 'utf8').split(/\r?\n/)[line - 1] ?? null;
  }

  /** Scan the staged tree and return the findings, failing loudly on a scan error. */
  function scan(): Finding[] {
    const findings = scanStagedTree(scanRoot);
    expect(findings).not.toBeNull();
    return findings!;
  }

  it('renders the true secret length and head fragment for a secret after line 1', () => {
    // The defect in the field: the reported column is one high on every line
    // after the first, so the value rendered as `39 chars` starting `hp_`.
    write(
      'shared/projects/proj/session-a.jsonl',
      ['{"type":"user","text":"first line"}', `{"type":"user","text":"token = ${PAT}"}`, ''].join(
        '\n',
      ),
    );

    const findings = scan();
    expect(findings).toHaveLength(1);
    expect(findings[0].StartLine).toBe(2);

    const rendered = renderFindingBlock(findings[0], readLine).join('\n');

    expect(rendered).toContain(`${PAT.length} chars`);
    expect(rendered).toContain(`${PAT.slice(0, 4)}...${PAT.slice(-4)}`);
    // The full secret still never reaches the screen.
    expect(rendered).not.toContain(PAT);
  });

  it('reports the same length whether the secret sits on line 1 or deep in the file', () => {
    // Line 1 is the one case the reported columns are already correct on, so
    // agreement between the two proves the correction is not itself a shift.
    write('shared/projects/proj/first.jsonl', `{"type":"user","text":"token = ${PAT}"}\n`);
    write(
      'shared/projects/proj/deep.jsonl',
      [
        ...Array.from({ length: 9 }, (_, i) => `{"pad":${i}}`),
        `{"text":"token = ${PAT}"}`,
        '',
      ].join('\n'),
    );

    const findings = scan();
    const first = findings.find((f) => f.File.endsWith('first.jsonl'));
    const deep = findings.find((f) => f.File.endsWith('deep.jsonl'));
    expect(first).toBeDefined();
    expect(deep).toBeDefined();
    expect(deep?.StartLine).toBe(10);

    const valueLine = (f: Finding) =>
      renderFindingBlock(f, readLine).find((l) => l.startsWith('  value: '));

    expect(valueLine(deep!)).toBe(valueLine(first!));
    expect(valueLine(deep!)).toContain(`${PAT.length} chars`);
  });

  it('does not double the character at the label seam on the near: line', () => {
    // `near` used to be the line-derived lead spliced onto the finding's own
    // Match template. With the lead running one byte long the two overlapped,
    // and the seam printed the label's first character twice (`ssecret`).
    write(
      'shared/projects/proj/labelled.jsonl',
      ['{"pad":0}', `{"text":"    const secret = '${PAT}'"}`, ''].join('\n'),
    );

    const findings = scan();
    expect(findings.length).toBeGreaterThan(0);
    const rendered = renderFindingBlock(findings[0], readLine).join('\n');

    expect(rendered).not.toContain('ssecret');
    expect(rendered).toContain('secret');
    expect(rendered).not.toContain(PAT);
  });

  it('groups repeat occurrences of one secret into a single prompt', () => {
    // Duplicate prompts were downstream of the offset: an unresolvable value
    // falls back to a key carrying the column, so every occurrence asked its
    // own question.
    write(
      'shared/projects/proj/twice.jsonl',
      ['{"pad":0}', `{"text":"a = ${PAT} and b = ${PAT}"}`, ''].join('\n'),
    );

    const findings = scan();
    expect(findings.length).toBeGreaterThan(1);
    const values = new Set(
      findings.map((f) => renderFindingBlock(f, readLine).find((l) => l.startsWith('  value: '))),
    );
    expect(values.size).toBe(1);
  });
});
