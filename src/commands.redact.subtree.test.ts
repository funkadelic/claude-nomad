import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// listSubagentTranscripts
// ---------------------------------------------------------------------------

describe('listSubagentTranscripts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nomad-subtree-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns only agent-*.jsonl paths (excluding .meta.json siblings)', async () => {
    const { listSubagentTranscripts } = await import('./commands.redact.subtree.ts');
    const sessionDir = join(tmpDir, 'sid123');
    const subagentsDir = join(sessionDir, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, 'agent-1.jsonl'), '{}');
    writeFileSync(join(subagentsDir, 'agent-2.jsonl'), '{}');
    writeFileSync(join(subagentsDir, 'agent-1.meta.json'), '{}');

    const result = listSubagentTranscripts(sessionDir);

    expect(result).toHaveLength(2);
    expect(result.every((p) => p.endsWith('.jsonl'))).toBe(true);
    expect(result.some((p) => p.includes('agent-1.jsonl'))).toBe(true);
    expect(result.some((p) => p.includes('agent-2.jsonl'))).toBe(true);
    expect(result.every((p) => !p.includes('.meta.json'))).toBe(true);
  });

  it('returns [] when the session dir has no subagents/ subdir', async () => {
    const { listSubagentTranscripts } = await import('./commands.redact.subtree.ts');
    const sessionDir = join(tmpDir, 'no-subagents');
    mkdirSync(sessionDir, { recursive: true });

    expect(listSubagentTranscripts(sessionDir)).toEqual([]);
  });

  it('returns [] when the session dir does not exist', async () => {
    const { listSubagentTranscripts } = await import('./commands.redact.subtree.ts');
    const missingDir = join(tmpDir, 'does-not-exist');

    expect(listSubagentTranscripts(missingDir)).toEqual([]);
  });

  it('returns [] when subagents is a file (not a directory)', async () => {
    const { listSubagentTranscripts } = await import('./commands.redact.subtree.ts');
    const sessionDir = join(tmpDir, 'sid-file-subagents');
    mkdirSync(sessionDir, { recursive: true });
    // Write a regular file named "subagents" to trip the isDirectory() guard.
    writeFileSync(join(sessionDir, 'subagents'), 'not a directory');

    expect(listSubagentTranscripts(sessionDir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// newestSubtreeMtimeMs
// ---------------------------------------------------------------------------

describe('newestSubtreeMtimeMs', () => {
  it('returns the main mtime when no agent paths are given', async () => {
    const { newestSubtreeMtimeMs } = await import('./commands.redact.subtree.ts');
    const statMtime = (_p: string) => 1000;
    expect(newestSubtreeMtimeMs('/main/sid.jsonl', [], statMtime)).toBe(1000);
  });

  it('returns the agent mtime when it is newer than the main mtime', async () => {
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

  it('returns the main mtime when it is newer than all agent mtimes', async () => {
    const { newestSubtreeMtimeMs } = await import('./commands.redact.subtree.ts');
    const mtimes: Record<string, number> = {
      '/main/sid.jsonl': 5000,
      '/main/sid/subagents/agent-1.jsonl': 1000,
      '/main/sid/subagents/agent-2.jsonl': 2000,
    };
    const statMtime = (p: string) => mtimes[p] ?? 0;

    const result = newestSubtreeMtimeMs(
      '/main/sid.jsonl',
      ['/main/sid/subagents/agent-1.jsonl', '/main/sid/subagents/agent-2.jsonl'],
      statMtime,
    );

    expect(result).toBe(5000);
  });

  it('returns max when agent mtime equals main mtime', async () => {
    const { newestSubtreeMtimeMs } = await import('./commands.redact.subtree.ts');
    const statMtime = (_p: string) => 3000;

    expect(
      newestSubtreeMtimeMs('/main/sid.jsonl', ['/main/sid/subagents/agent-1.jsonl'], statMtime),
    ).toBe(3000);
  });

  it('uses real statSync when no statMtime is injected', async () => {
    const { newestSubtreeMtimeMs } = await import('./commands.redact.subtree.ts');
    // Build two real temp files so the default real-fs reader has files to stat.
    const dir = mkdtempSync(join(tmpdir(), 'nomad-mtime-'));
    try {
      const mainPath = join(dir, 'sid.jsonl');
      const agentPath = join(dir, 'agent-1.jsonl');
      writeFileSync(mainPath, '{}');
      writeFileSync(agentPath, '{}');
      // Call without injected statMtime to exercise the default parameter branch.
      const result = newestSubtreeMtimeMs(mainPath, [agentPath]);
      expect(result).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
