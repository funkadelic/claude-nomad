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
 * Scan-FAILURE cases driven by a mocked `node:child_process` (no real gitleaks
 * needed): the unparseable-report FAIL (D-10), a non-ENOENT throw out of
 * `scanStagedTree`, and the no-stream-leak guarantee on a protect --staged
 * failure. The cleanup + partition-gating cases live in `.scan2.test.ts`. Every
 * `vi.doMock` here is paired with a `vi.doUnmock` in `afterEach` because
 * `vi.restoreAllMocks` does NOT clear `vi.doMock` module mocks (they would
 * otherwise leak across files).
 */
describe('reportCheckShared (mocked scan failures)', () => {
  let snapshot: EnvSnapshot;
  let testHome: string;

  beforeEach(() => {
    snapshot = saveEnv();
  });

  afterEach(() => {
    // Pair every doMock with a doUnmock; restoreAllMocks does NOT clear doMock
    // module mocks, so an unpaired mock would leak into later files.
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    restoreEnv(snapshot, testHome);
  });

  it('emits a scan-failed fail row, exits 1, and writes no session row when the report is unparseable (D-10)', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-unparseable.jsonl'),
      `{"role":"user","text":"benign content"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          const list = args ?? [];
          // The gitleaks `version` probe and the git init/add stage must succeed
          // so the flow reaches the scan; only the protect --staged scan fails.
          if (list[0] === 'version') return Buffer.from('8.0.0');
          if (list[0] === 'init' || list[0] === 'add') return Buffer.from('');
          // gitleaks protect --staged exits non-zero WITHOUT writing any report
          // at --report-path, so readGitleaksReport returns null (the unparseable
          // signal) and the reporter reports scan-failed rather than chasing
          // phantom sessions.
          throw Object.assign(new Error('gitleaks exited 1'), { status: 1 });
        }),
      };
    });

    expect(process.exitCode).toBe(0);
    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const rows = section.items.join('\n');
    expect(section.items.some((r) => r.includes(failGlyph))).toBe(true);
    expect(rows).toMatch(/scan failed/i);
    expect(rows).not.toContain('session ');
    expect(section.items.some((r) => r.includes(okGlyph))).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('emits one scan-failed fail row and exits 1 when scanStagedTree throws a non-ENOENT error', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    // A real session dir maps to this host so buildScanTree stages it
    // (staged > 0) and the flow reaches scanStagedTree inside the inner try.
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-scan-throw.jsonl'),
      `{"role":"user","text":"benign content"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    // scanStagedTree swallows non-ENOENT execFileSync failures, so drive the
    // error from its pre-try `mkdirSync(cacheDir)`. reportCheckShared also
    // mkdirs that same cacheDir once before the scan, so throw only on the
    // SECOND cacheDir mkdir (scanStagedTree's), leaving the reporter's own
    // setup intact. The non-ENOENT error then escapes scanStagedTree into the
    // reporter's inner catch (the scan-failed fail row + exitCode 1).
    let cacheMkdirs = 0;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        mkdirSync: vi.fn((p: fsModule.PathLike, o?: fsModule.MakeDirectoryOptions) => {
          if (String(p).includes(join('.cache', 'claude-nomad'))) {
            cacheMkdirs++;
            if (cacheMkdirs >= 2) {
              throw Object.assign(new Error('mkdir cache failed: disk error'), { code: 'EIO' });
            }
          }
          return actual.mkdirSync(p, o);
        }),
      };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        // The version probe must succeed so the flow reaches the scan; the
        // mkdirSync throw above fires before any git/gitleaks call.
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) =>
          (args ?? [])[0] === 'version' ? Buffer.from('8.0.0') : Buffer.from(''),
        ),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const failRows = section.items.filter((r) => r.includes(failGlyph));
    expect(failRows.length).toBe(1);
    expect(failRows[0]).toMatch(/scan failed: .*disk error/);
    expect(section.items.some((r) => r.includes(okGlyph))).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('never leaks gitleaks stderr/stdout into the scan-failed row when protect --staged fails', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-scanmsg.jsonl'),
      `{"role":"user","text":"benign content"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    const secretInStreams = 'TOP_SECRET_STREAM_CONTENT';
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          const list = args ?? [];
          if (list[0] === 'version') return Buffer.from('8.0.0');
          // git init / git add succeed; only the protect --staged scan fails.
          if (list[0] === 'init' || list[0] === 'add') return Buffer.from('');
          // gitleaks protect --staged fails and carries stderr/stdout that must
          // never reach the doctor row (the shared scanStagedTree is called with
          // forwardStreams=false, so the streams are dropped entirely).
          throw Object.assign(new Error('gitleaks protect exited 126: bad invocation'), {
            status: 126,
            stderr: Buffer.from(secretInStreams),
            stdout: Buffer.from(secretInStreams),
          });
        }),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const rows = section.items.join('\n');
    // No report was written, so the helper returns null and the doctor reports a
    // scan-failed row. The redacted-but-sensitive streams must never appear.
    expect(rows).toMatch(/scan failed/i);
    expect(rows).not.toContain(secretInStreams);
    expect(process.exitCode).toBe(1);
  });
});
