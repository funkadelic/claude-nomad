import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as cpModule from 'node:child_process';
import type * as fsModule from 'node:fs';

import { failGlyph, okGlyph } from './color.ts';
import {
  type EnvSnapshot,
  type Section,
  makeEnv,
  restoreEnv,
  saveEnv,
  writePathMap,
} from './commands.doctor.check-shared.test-helpers.ts';

/**
 * Scan cleanup + partition-gating cases driven by a mocked `node:child_process`
 * (no real gitleaks needed): the finally-block temp cleanup on the failure path
 * (D-04), the empty-findings clean row, and the mixed session/`other` findings
 * report. Every `vi.doMock` here is paired with a `vi.doUnmock` in `afterEach`
 * because `vi.restoreAllMocks` does NOT clear `vi.doMock` module mocks (they
 * would otherwise leak across files).
 */
describe('reportCheckShared (mocked scan cleanup + partition)', () => {
  let snapshot: EnvSnapshot;
  let testHome: string;

  beforeEach(() => {
    snapshot = saveEnv();
  });

  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    restoreEnv(snapshot, testHome);
  });

  it('removes the temp report and temp tree in finally on the failure path (D-04)', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-fail-cleanup.jsonl'),
      `{"role":"user","text":"benign content"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    const rmCalls: { path: string; opts: unknown }[] = [];
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        // Record every removal so we can assert the finally block removed both
        // the report file ({ force: true }) and the temp tree ({ recursive:
        // true, force: true }); still delegate to the real rmSync so the disk
        // is actually cleaned.
        rmSync: vi.fn((p: fsModule.PathLike, o?: fsModule.RmOptions) => {
          rmCalls.push({ path: String(p), opts: o });
          actual.rmSync(p, o);
        }),
      };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          const list = args ?? [];
          if (list[0] === 'version') return Buffer.from('8.0.0');
          if (list[0] === 'init' || list[0] === 'add') return Buffer.from('');
          throw Object.assign(new Error('gitleaks exited 1'), { status: 1 });
        }),
      };
    });

    const { existsSync } = await import('node:fs');
    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    expect(process.exitCode).toBe(1);
    const reportRm = rmCalls.find(
      (c) => c.path.includes('check-shared-') && c.path.endsWith('.json'),
    );
    const treeRm = rmCalls.find((c) => c.path.includes('check-shared-tree-'));
    expect(reportRm).toBeDefined();
    expect(reportRm?.opts).toMatchObject({ force: true });
    expect(treeRm).toBeDefined();
    expect(treeRm?.opts).toMatchObject({ recursive: true, force: true });
    // The artifacts must be gone from disk after the run.
    expect(reportRm && existsSync(reportRm.path)).toBeFalsy();
    expect(treeRm && existsSync(treeRm.path)).toBeFalsy();
  });

  it('reports clean when a non-zero scan still writes an empty findings report', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-empty.jsonl'),
      `{"role":"user","text":"benign"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          const list = args ?? [];
          if (list[0] === 'version') return Buffer.from('8.0.0');
          if (list[0] === 'init' || list[0] === 'add') return Buffer.from('');
          // gitleaks protect --staged exits non-zero but writes a parseable
          // empty array: both partition buckets are empty, so the reporter emits
          // the clean row (staged count) rather than a phantom-session fail.
          const rp = list.find((a) => a.startsWith('--report-path='));
          if (rp) writeFileSync(rp.slice('--report-path='.length), '[]');
          throw Object.assign(new Error('gitleaks exited 1'), { status: 1 });
        }),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    expect(section.items.some((r) => r.includes(okGlyph) && r.includes('1 project'))).toBe(true);
    expect(section.items.some((r) => r.includes(failGlyph))).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  it('emits both an other-bucket leak row and per-session rows when findings mix session and nested paths', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-mixed.jsonl'),
      `{"role":"user","text":"benign"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    // Two findings share session `sid-1` (exercises the duplicate-sid path in
    // the logical-name capture) and one is a nested path that matches neither
    // the flat SESSION_PATH nor any session (the `other` bucket).
    const report = JSON.stringify([
      {
        RuleID: 'aws-access-key',
        Description: 'AWS Access Key',
        File: 'shared/projects/foo/sid-1.jsonl',
        StartLine: 1,
        Match: 'REDACTED',
        Fingerprint: 'fp-a',
      },
      {
        RuleID: 'github-pat',
        Description: 'GitHub Personal Access Token',
        File: 'shared/projects/foo/sid-1.jsonl',
        StartLine: 2,
        Match: 'REDACTED',
        Fingerprint: 'fp-b',
      },
      {
        RuleID: 'generic-api-key',
        Description: 'Generic API Key',
        File: 'shared/projects/foo/subagents/nested.jsonl',
        StartLine: 1,
        Match: 'REDACTED',
        Fingerprint: 'fp-c',
      },
      // A second github-pat hit (different file) exercises legend dedup: the
      // footer lists the rule once, not once per occurrence.
      {
        RuleID: 'github-pat',
        Description: 'GitHub Personal Access Token',
        File: 'shared/projects/foo/subagents/other.jsonl',
        StartLine: 9,
        Match: 'REDACTED',
        Fingerprint: 'fp-d',
      },
    ]);
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          const list = args ?? [];
          if (list[0] === 'version') return Buffer.from('8.0.0');
          if (list[0] === 'init' || list[0] === 'add') return Buffer.from('');
          const rp = list.find((a) => a.startsWith('--report-path='));
          if (rp) writeFileSync(rp.slice('--report-path='.length), report);
          throw Object.assign(new Error('gitleaks exited 1'), { status: 1 });
        }),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const rows = section.items.join('\n');
    // Session row leads with both RuleID counts for sid-1, then names the session.
    expect(rows).toMatch(/aws-access-key \(1\).*in session sid-1/);
    expect(rows).toContain('github-pat (1)');
    // Other-bucket row leads with the RuleID, then names the nested path.
    expect(rows).toContain('generic-api-key leak in shared/projects/foo/subagents/nested.jsonl');
    // The scrub hint reuses the captured logical/encoded mapping.
    expect(rows).toMatch(/rotate the credential, then scrub .*sid-1\.jsonl/);
    // Footer legend explains each distinct RuleID once, set off by blank lines.
    expect(rows).toContain('[aws-access-key]: AWS Access Key');
    expect(rows).toContain('[github-pat]: GitHub Personal Access Token');
    expect(rows).toContain('[generic-api-key]: Generic API Key');
    // One legend entry per rule (deduplicated), not one per finding.
    expect(section.items.filter((r) => r.includes('[github-pat]:'))).toHaveLength(1);
    // Blank-line separators bracket the legend block.
    expect(section.items.filter((r) => r === '').length).toBeGreaterThanOrEqual(2);
    expect(section.items.some((r) => r.includes(okGlyph))).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('omits the description legend when findings carry no Description (graceful degradation)', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-nodesc.jsonl'),
      `{"role":"user","text":"benign"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    // An older gitleaks (or a custom rule) omits the Description field. The
    // leak row and hints still emit; the legend block (and its blank lines)
    // is suppressed entirely.
    const report = JSON.stringify([
      {
        RuleID: 'aws-access-key',
        File: 'shared/projects/foo/sid-1.jsonl',
        StartLine: 1,
        Match: 'REDACTED',
        Fingerprint: 'fp-x',
      },
    ]);
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          const list = args ?? [];
          if (list[0] === 'version') return Buffer.from('8.0.0');
          if (list[0] === 'init' || list[0] === 'add') return Buffer.from('');
          const rp = list.find((a) => a.startsWith('--report-path='));
          if (rp) writeFileSync(rp.slice('--report-path='.length), report);
          throw Object.assign(new Error('gitleaks exited 1'), { status: 1 });
        }),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const rows = section.items.join('\n');
    // Leak row still emits, but no legend bracket and no blank-line separators.
    expect(rows).toMatch(/aws-access-key \(1\).*in session sid-1/);
    expect(rows).not.toContain('[aws-access-key]:');
    expect(section.items.some((r) => r === '')).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});
