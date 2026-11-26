import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withFilteredFindings } from './gitleaks.filtered.ts';
import { scanFile, scanStagedTree, type Finding, type ScanFileOptions } from './gitleaks.scan.ts';

/**
 * Real-git tests for the clean-filter re-scan, plus real-gitleaks end-to-end
 * tests through `scanStagedTree`. Hermetic setup mirrors `gitleaks-beta-header.test.ts`.
 */
const hasGitleaks = ((): boolean => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Env vars the suite isolates; USERPROFILE is the home on native Windows. */
const ISOLATED = [
  'HOME',
  'USERPROFILE',
  'NOMAD_REPO',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_OBJECT_DIRECTORY',
];

/** Deterministic github-pat-shaped token `i`, assembled at runtime. */
const patFor = (i: number): string => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const body = [...createHash('sha512').update(`k${i}`).digest()]
    .map((b) => abc[b % abc.length])
    .join('')
    .slice(0, 36);
  return ['gh', 'p_', body].join('');
};

/** Minimal `Finding` carrying fingerprint `fp`. */
const finding = (fp: string): Finding => ({
  RuleID: 'r',
  File: 'a.txt',
  StartLine: 1,
  StartColumn: 1,
  EndColumn: 2,
  Match: 'REDACTED',
  Fingerprint: fp,
});

describe('withFilteredFindings and scanStagedTree clean-filter re-scan', () => {
  let saved: Record<string, string | undefined>;
  let testHome: string;
  let scanRoot: string;

  beforeEach(() => {
    saved = Object.fromEntries(ISOLATED.map((k) => [k, process.env[k]]));
    for (const k of ISOLATED) delete process.env[k];
    testHome = mkdtempSync(join(tmpdir(), 'nomad-gitleaks-filtered-home-'));
    const repoUnderHome = join(testHome, 'claude-nomad');
    mkdirSync(repoUnderHome, { recursive: true });
    const here = dirname(fileURLToPath(import.meta.url));
    copyFileSync(
      join(here, '..', '..', '..', '.gitleaks.toml'),
      join(repoUnderHome, '.gitleaks.toml'),
    );
    process.env.HOME = testHome;
    process.env.USERPROFILE = testHome;
    scanRoot = mkdtempSync(join(tmpdir(), 'nomad-gitleaks-filtered-scan-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ISOLATED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(testHome, { recursive: true, force: true });
    rmSync(scanRoot, { recursive: true, force: true });
  });

  /** Run git in `scanRoot`. */
  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: scanRoot, stdio: 'pipe' });
  }

  /** Write `body` at `rel` under `scanRoot`. */
  function write(rel: string, body: string): void {
    writeFileSync(join(scanRoot, rel), body);
  }

  /** A fake ScanFn that records its calls and returns `result`. */
  function recorder(result: Finding[] | null): {
    scan: (p: string, o?: ScanFileOptions) => Finding[] | null;
    calls: [string, ScanFileOptions | undefined][];
  } {
    const calls: [string, ScanFileOptions | undefined][] = [];
    return {
      calls,
      scan: (p, o) => {
        calls.push([p, o]);
        return result;
      },
    };
  }

  /** Init `scanRoot` with attributes `attrs` and files a/b/c.txt, all staged. */
  function stageAttributed(attrs: string): void {
    git('init', '-q');
    write('.gitattributes', attrs);
    for (const f of ['a.txt', 'b.txt', 'c.txt']) write(f, 'x\n');
    git('add', '-A');
  }

  it('re-scans only paths whose filter attribute is set', () => {
    stageAttributed('a.txt filter=fake\nb.txt -filter\n');
    const { scan, calls } = recorder([]);
    expect(withFilteredFindings(scanRoot, [], scan, false)).toEqual([]);
    expect(calls).toEqual([
      [
        join(scanRoot, 'a.txt'),
        { stagedRel: 'a.txt', redact: true, repoDir: scanRoot, forwardStreams: false },
      ],
    ]);
  });

  it('skips a staged deletion', () => {
    stageAttributed('a.txt filter=fake\n');
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'init',
      '--no-verify',
    );
    git('rm', '-q', 'a.txt');
    const { scan, calls } = recorder([]);
    const staged = [finding('s')];
    expect(withFilteredFindings(scanRoot, staged, scan, false)).toEqual(staged);
    expect(calls).toEqual([]);
  });

  it('never calls the scan when no filter is attributed', () => {
    stageAttributed('');
    const { scan, calls } = recorder([]);
    const staged = [finding('s')];
    expect(withFilteredFindings(scanRoot, staged, scan, false)).toEqual(staged);
    expect(calls).toEqual([]);
  });

  it('merges filtered findings deduped by fingerprint', () => {
    stageAttributed('a.txt filter=fake\n');
    const { scan } = recorder([finding('fp1'), finding('fp2')]);
    expect(withFilteredFindings(scanRoot, [finding('fp1')], scan, false)).toEqual([
      finding('fp1'),
      finding('fp2'),
    ]);
  });

  it('returns null when a per-file scan fails', () => {
    stageAttributed('a.txt filter=fake\n');
    expect(withFilteredFindings(scanRoot, [], recorder(null).scan, false)).toBeNull();
  });

  it('fails closed when the listing fails, naming the cause only when forwarding', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const missing = join(scanRoot, 'nope');
    expect(withFilteredFindings(missing, [], recorder([]).scan, false)).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(withFilteredFindings(missing, [], recorder([]).scan, true)).toBeNull();
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0][0])).toMatch(/^scan aborted: /);
  });

  describe.skipIf(!hasGitleaks)('real gitleaks', () => {
    it('reports a secret a clean filter hides from the index, redacted', () => {
      const pat = patFor(1);
      git('init', '-q');
      git('config', 'filter.fake.clean', 'sed s/./x/g');
      write('.gitattributes', 'secret.txt filter=fake\n');
      write('secret.txt', `token = ${pat}\n`);
      const found = scanStagedTree(scanRoot);
      expect(found).toHaveLength(1);
      expect(found?.[0]).toMatchObject({
        RuleID: 'github-pat',
        File: 'secret.txt',
        Secret: 'REDACTED',
      });
      expect(found?.[0].Match).not.toContain(pat);
    });

    it('is unchanged for a repo with no filter attributes', () => {
      write('plain.txt', `token = ${patFor(2)}\n`);
      const found = scanStagedTree(scanRoot);
      expect(found).toHaveLength(1);
      expect(found?.[0].File).toBe('plain.txt');
    });

    it('reports one finding when the attributed filter has no driver', () => {
      write('.gitattributes', 'secret.txt filter=nodriver\n');
      write('secret.txt', `token = ${patFor(3)}\n`);
      const found = scanStagedTree(scanRoot);
      expect(found).toHaveLength(1);
      const alone = withFilteredFindings(scanRoot, [], scanFile, false);
      expect(alone).toHaveLength(1);
      expect(alone?.[0].Fingerprint).toBe(found?.[0].Fingerprint);
    });
  });
});
