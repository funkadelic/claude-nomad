import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as cpModule from 'node:child_process';
import type * as fsModule from 'node:fs';

import { failGlyph } from '../../../render/color.ts';
import {
  type EnvSnapshot,
  type Section,
  makeEnv,
  restoreEnv,
  saveEnv,
  writePathMap,
} from './shared.test-helpers.ts';

/** An overlay block with no `paths`, which the overlay guard rejects. */
const UNSAFE_OVERLAY = "[[allowlists]]\nregexes = ['''tok-[a-z]+''']\n";
/** A path-scoped overlay block the guard accepts. */
const SAFE_OVERLAY =
  "[[allowlists]]\ncondition = \"AND\"\npaths = ['''^notes/x\\.txt$''']\nregexes = ['''tok-[a-z]+''']\n";

/** Write `.gitleaks.overlay.toml` into the sandbox sync repo. */
function writeOverlay(testHome: string, body: string): void {
  writeFileSync(join(testHome, 'claude-nomad', '.gitleaks.overlay.toml'), body);
}

/** Run the reporter with the probe already satisfied, so no gitleaks binary is needed. */
async function run(): Promise<Section> {
  const { reportCheckShared } = await import('./shared.ts');
  const section: Section = { header: 'Shared scan', items: [] };
  reportCheckShared(section, true);
  return section;
}

describe('reportCheckShared overlay validation', () => {
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

  /** Assert a single overlay FAIL row, exit 1, and no other rows. */
  function expectRejected(section: Section): void {
    expect(section.items).toHaveLength(1);
    expect(section.items[0]).toContain(failGlyph);
    expect(section.items[0]).toContain('gitleaks overlay rejected');
    expect(process.exitCode).toBe(1);
  }

  it('fails an unsafe overlay when nothing is staged', async () => {
    testHome = makeEnv().testHome;
    writeOverlay(testHome, UNSAFE_OVERLAY);
    expectRejected(await run());
  });

  it('fails an unsafe overlay when only committed memory would be scanned', async () => {
    testHome = makeEnv().testHome;
    const memDir = join(testHome, 'claude-nomad', 'shared', 'projects', 'foo', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'note.md'), 'nothing secret\n');
    writeOverlay(testHome, UNSAFE_OVERLAY);
    expectRejected(await run());
  });

  it('fails an unsafe overlay when local sessions are staged', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(join(testHome, '.claude', 'projects', env.encodedDir, 's.jsonl'), '{}\n');
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });
    writeOverlay(testHome, UNSAFE_OVERLAY);
    expectRejected(await run());
  });

  it('fails an unsafe overlay even when gitleaks is not on PATH', async () => {
    testHome = makeEnv().testHome;
    writeOverlay(testHome, UNSAFE_OVERLAY);
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof cpModule>()),
      execFileSync: vi.fn(() => {
        throw Object.assign(new Error('spawn gitleaks ENOENT'), { code: 'ENOENT' });
      }),
    }));
    const { reportCheckShared } = await import('./shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);
    expectRejected(section);
  });

  it('passes a safe overlay and removes its generated temp config', async () => {
    testHome = makeEnv().testHome;
    writeOverlay(testHome, SAFE_OVERLAY);
    // Record only the dirs this run creates, so a parallel worker's temp dirs cannot interfere.
    const created: string[] = [];
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        mkdtempSync: vi.fn((prefix: string) => {
          const dir = actual.mkdtempSync(prefix);
          if (prefix.includes('nomad-gitleaks-cfg-')) created.push(dir);
          return dir;
        }),
      };
    });
    const section = await run();
    expect(section.items.some((r) => r.includes('overlay rejected'))).toBe(false);
    expect(process.exitCode).toBe(0);
    expect(created.length).toBeGreaterThan(0);
    expect(created.filter((d) => existsSync(d))).toEqual([]);
  });
});
