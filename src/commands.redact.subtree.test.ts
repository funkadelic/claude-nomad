import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// listSubtreeFiles
// ---------------------------------------------------------------------------

describe('listSubtreeFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nomad-subtree-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns all regular files recursively (jsonl, meta.json, txt)', async () => {
    const { listSubtreeFiles } = await import('./commands.redact.subtree.ts');
    const sessionDir = join(tmpDir, 'sid123');
    const subagentsDir = join(sessionDir, 'subagents');
    const toolResultsDir = join(sessionDir, 'tool-results');
    mkdirSync(subagentsDir, { recursive: true });
    mkdirSync(toolResultsDir, { recursive: true });
    writeFileSync(join(subagentsDir, 'agent-1.jsonl'), '{}');
    writeFileSync(join(subagentsDir, 'agent-1.meta.json'), '{}');
    writeFileSync(join(toolResultsDir, 'toolu_abc.txt'), 'output');

    const result = listSubtreeFiles(sessionDir);

    expect(result).toHaveLength(3);
    expect(result.some((p) => p.endsWith('agent-1.jsonl'))).toBe(true);
    expect(result.some((p) => p.endsWith('agent-1.meta.json'))).toBe(true);
    expect(result.some((p) => p.endsWith('toolu_abc.txt'))).toBe(true);
  });

  it('returns [] when the session dir does not exist', async () => {
    const { listSubtreeFiles } = await import('./commands.redact.subtree.ts');
    const missingDir = join(tmpDir, 'does-not-exist');
    expect(listSubtreeFiles(missingDir)).toEqual([]);
  });

  it('returns [] when the session dir exists but is empty', async () => {
    const { listSubtreeFiles } = await import('./commands.redact.subtree.ts');
    const sessionDir = join(tmpDir, 'empty-sid');
    mkdirSync(sessionDir, { recursive: true });
    expect(listSubtreeFiles(sessionDir)).toEqual([]);
  });

  it('returns [] when sessionDir is a file (not a directory)', async () => {
    const { listSubtreeFiles } = await import('./commands.redact.subtree.ts');
    const notADir = join(tmpDir, 'not-a-dir');
    writeFileSync(notADir, 'not a directory');
    expect(listSubtreeFiles(notADir)).toEqual([]);
  });

  it('skips symlinks and does not follow them out of the subtree', async () => {
    const { listSubtreeFiles } = await import('./commands.redact.subtree.ts');
    const sessionDir = join(tmpDir, 'sid-sym');
    mkdirSync(sessionDir, { recursive: true });
    const realFile = join(tmpDir, 'outside.txt');
    writeFileSync(realFile, 'outside');
    // Create a symlink inside the session dir pointing outside.
    symlinkSync(realFile, join(sessionDir, 'link.txt'));
    // The symlink should be excluded.
    expect(listSubtreeFiles(sessionDir)).toEqual([]);
  });

  it('returns sorted paths', async () => {
    const { listSubtreeFiles } = await import('./commands.redact.subtree.ts');
    const sessionDir = join(tmpDir, 'sid-sort');
    const subDir = join(sessionDir, 'z-dir');
    const aDir = join(sessionDir, 'a-dir');
    mkdirSync(subDir, { recursive: true });
    mkdirSync(aDir, { recursive: true });
    writeFileSync(join(subDir, 'z.txt'), '');
    writeFileSync(join(aDir, 'a.txt'), '');

    const result = listSubtreeFiles(sessionDir);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('a-dir');
    expect(result[1]).toContain('z-dir');
  });
});

// ---------------------------------------------------------------------------
// newestSubtreeMtimeMs
// ---------------------------------------------------------------------------

describe('newestSubtreeMtimeMs', () => {
  it('returns the main mtime when no subtree files are given', async () => {
    const { newestSubtreeMtimeMs } = await import('./commands.redact.subtree.ts');
    const statMtime = (_p: string) => 1000;
    expect(newestSubtreeMtimeMs('/main/sid.jsonl', [], statMtime)).toBe(1000);
  });

  it('returns the subtree file mtime when it is newer than the main mtime', async () => {
    const { newestSubtreeMtimeMs } = await import('./commands.redact.subtree.ts');
    const mtimes: Record<string, number> = {
      '/main/sid.jsonl': 1000,
      '/main/sid/subagents/agent-1.jsonl': 9999,
    };
    const statMtime = (p: string) => mtimes[p] ?? 0;

    const result = newestSubtreeMtimeMs(
      '/main/sid.jsonl',
      ['/main/sid/subagents/agent-1.jsonl'],
      statMtime,
    );

    expect(result).toBe(9999);
  });

  it('returns the main mtime when it is newer than all subtree files', async () => {
    const { newestSubtreeMtimeMs } = await import('./commands.redact.subtree.ts');
    const mtimes: Record<string, number> = {
      '/main/sid.jsonl': 5000,
      '/main/sid/subagents/agent-1.jsonl': 1000,
      '/main/sid/tool-results/x.txt': 2000,
    };
    const statMtime = (p: string) => mtimes[p] ?? 0;

    const result = newestSubtreeMtimeMs(
      '/main/sid.jsonl',
      ['/main/sid/subagents/agent-1.jsonl', '/main/sid/tool-results/x.txt'],
      statMtime,
    );

    expect(result).toBe(5000);
  });

  it('returns max when subtree file mtime equals main mtime', async () => {
    const { newestSubtreeMtimeMs } = await import('./commands.redact.subtree.ts');
    const statMtime = (_p: string) => 3000;

    expect(
      newestSubtreeMtimeMs('/main/sid.jsonl', ['/main/sid/subagents/agent-1.jsonl'], statMtime),
    ).toBe(3000);
  });

  it('uses real statSync when no statMtime is injected', async () => {
    const { newestSubtreeMtimeMs } = await import('./commands.redact.subtree.ts');
    const dir = mkdtempSync(join(tmpdir(), 'nomad-mtime-'));
    try {
      const mainPath = join(dir, 'sid.jsonl');
      const agentPath = join(dir, 'agent-1.jsonl');
      writeFileSync(mainPath, '{}');
      writeFileSync(agentPath, '{}');
      const result = newestSubtreeMtimeMs(mainPath, [agentPath]);
      expect(result).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('spans tool-results files: a newer tool-results file raises the mtime', async () => {
    const { newestSubtreeMtimeMs } = await import('./commands.redact.subtree.ts');
    const mtimes: Record<string, number> = {
      '/main/sid.jsonl': 1000,
      '/main/sid/subagents/agent-1.jsonl': 2000,
      '/main/sid/tool-results/x.txt': 9999,
    };
    const statMtime = (p: string) => mtimes[p] ?? 0;

    const result = newestSubtreeMtimeMs(
      '/main/sid.jsonl',
      ['/main/sid/subagents/agent-1.jsonl', '/main/sid/tool-results/x.txt'],
      statMtime,
    );

    expect(result).toBe(9999);
  });
});

// ---------------------------------------------------------------------------
// applySubtreeRedactions
// ---------------------------------------------------------------------------

describe('applySubtreeRedactions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nomad-apply-sub-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('redacts main file when mainFindings is non-empty', async () => {
    const { applySubtreeRedactions } = await import('./commands.redact.subtree.ts');
    const mainPath = join(tmpDir, 'sid.jsonl');
    writeFileSync(mainPath, '{"text":"real-secret"}\n');

    const { total, dirty } = applySubtreeRedactions(
      mainPath,
      [{ StartLine: 1, Match: 'real-secret', RuleID: 'r1' }],
      [],
      undefined,
      'ts-x',
      () => [],
      false,
    );

    expect(total).toBe(1);
    expect(dirty).toHaveLength(1);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(mainPath, 'utf8')).toContain('[REDACTED:r1]');
    expect(readFileSync(mainPath, 'utf8')).not.toContain('real-secret');
  });

  it('redacts a subtree file when scan returns a finding', async () => {
    const { applySubtreeRedactions } = await import('./commands.redact.subtree.ts');
    const mainPath = join(tmpDir, 'sid.jsonl');
    const txtPath = join(tmpDir, 'x.txt');
    writeFileSync(mainPath, '{"text":"clean"}\n');
    writeFileSync(txtPath, 'secret-value\n');

    const fakeScan = (p: string) =>
      p === txtPath
        ? [
            {
              RuleID: 'r1',
              StartLine: 1,
              Match: 'secret-value',
              StartColumn: 1,
              EndColumn: 12,
              File: p,
              Fingerprint: 'fp',
            },
          ]
        : [];

    const { total, dirty } = applySubtreeRedactions(
      mainPath,
      [],
      [txtPath],
      undefined,
      'ts-x',
      fakeScan,
      false,
    );

    expect(total).toBe(1);
    expect(dirty).toHaveLength(1);
    expect(dirty[0].path).toBe(txtPath);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(txtPath, 'utf8')).toContain('[REDACTED:r1]');
  });

  it('dry-run: dirty list populated but no writes performed', async () => {
    const { applySubtreeRedactions } = await import('./commands.redact.subtree.ts');
    const mainPath = join(tmpDir, 'sid.jsonl');
    const original = '{"text":"real-secret"}\n';
    writeFileSync(mainPath, original);

    const { total, dirty } = applySubtreeRedactions(
      mainPath,
      [{ StartLine: 1, Match: 'real-secret', RuleID: 'r1' }],
      [],
      undefined,
      'ts-x',
      () => [],
      true,
    );

    expect(total).toBe(1);
    expect(dirty).toHaveLength(1);
    const { readFileSync } = await import('node:fs');
    // File must be unchanged (dry-run, no write).
    expect(readFileSync(mainPath, 'utf8')).toBe(original);
  });

  it('rule filter excludes non-matching subtree findings', async () => {
    const { applySubtreeRedactions } = await import('./commands.redact.subtree.ts');
    const mainPath = join(tmpDir, 'sid.jsonl');
    const agentPath = join(tmpDir, 'agent-1.jsonl');
    writeFileSync(mainPath, '{"text":"clean"}\n');
    writeFileSync(agentPath, '{"a":"AAA","b":"BBB"}\n');

    const fakeScan = (p: string) =>
      p === agentPath
        ? [
            {
              RuleID: 'rule-a',
              StartLine: 1,
              Match: 'AAA',
              StartColumn: 1,
              EndColumn: 3,
              File: p,
              Fingerprint: 'fa',
            },
            {
              RuleID: 'rule-b',
              StartLine: 1,
              Match: 'BBB',
              StartColumn: 8,
              EndColumn: 10,
              File: p,
              Fingerprint: 'fb',
            },
          ]
        : [];

    const { total } = applySubtreeRedactions(
      mainPath,
      [],
      [agentPath],
      'rule-a',
      'ts-x',
      fakeScan,
      false,
    );

    expect(total).toBe(1);
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(agentPath, 'utf8');
    expect(content).toContain('[REDACTED:rule-a]');
    expect(content).not.toContain('[REDACTED:rule-b]');
    expect(content).toContain('BBB');
  });

  it('scan null for a subtree file is silently skipped', async () => {
    const { applySubtreeRedactions } = await import('./commands.redact.subtree.ts');
    const mainPath = join(tmpDir, 'sid.jsonl');
    const agentPath = join(tmpDir, 'agent-1.jsonl');
    writeFileSync(mainPath, '{"text":"secret"}\n');
    writeFileSync(agentPath, '{"text":"content"}\n');

    const { total } = applySubtreeRedactions(
      mainPath,
      [{ StartLine: 1, Match: 'secret', RuleID: 'r1' }],
      [agentPath],
      undefined,
      'ts-x',
      (_p) => null,
      false,
    );

    // Only main (1 finding); agent scan returned null, so it's skipped.
    expect(total).toBe(1);
  });

  it('rule filter skips a file whose raw findings are all filtered out', async () => {
    const { applySubtreeRedactions } = await import('./commands.redact.subtree.ts');
    const mainPath = join(tmpDir, 'sid.jsonl');
    const agentPath = join(tmpDir, 'agent-1.jsonl');
    writeFileSync(mainPath, '{"text":"clean"}\n');
    writeFileSync(agentPath, '{"a":"AAA"}\n');

    // scan returns a finding for rule-b only; the caller requests rule-a.
    // filtered.length === 0 -> the file is skipped.
    const fakeScan = (p: string) =>
      p === agentPath
        ? [
            {
              RuleID: 'rule-b',
              StartLine: 1,
              Match: 'AAA',
              StartColumn: 1,
              EndColumn: 3,
              File: p,
              Fingerprint: 'fb',
            },
          ]
        : [];

    const { total, dirty } = applySubtreeRedactions(
      mainPath,
      [],
      [agentPath],
      'rule-a',
      'ts-x',
      fakeScan,
      false,
    );

    expect(total).toBe(0);
    expect(dirty).toEqual([]);
    // Agent file is untouched (all raw findings were filtered out).
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(agentPath, 'utf8')).toBe('{"a":"AAA"}\n');
  });

  it('returns total=0 and empty dirty list when everything is clean', async () => {
    const { applySubtreeRedactions } = await import('./commands.redact.subtree.ts');
    const mainPath = join(tmpDir, 'sid.jsonl');
    writeFileSync(mainPath, '{"text":"clean"}\n');

    const { total, dirty } = applySubtreeRedactions(
      mainPath,
      [],
      [],
      undefined,
      'ts-x',
      () => [],
      false,
    );

    expect(total).toBe(0);
    expect(dirty).toEqual([]);
  });
});
