import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the already-pushed-history advisory used by drop-session and
 * redact. Real-git suites exercise the upstream-ref resolution and pathspec
 * match against a bare-origin + clone pair; a mocked-child_process suite covers
 * the defensive degrade-to-silent branches.
 */

/** Run a git command in `cwd`; throws on non-zero exit. */
function g(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Build a bare origin plus a local clone. When `sessions` is given, each entry
 * is committed under `shared/projects/foo/<entry>` and pushed, so the cloned
 * local repo's upstream history contains it.
 */
function buildPushedRepo(tmp: string, sessions: string[]): { local: string } {
  const origin = join(tmp, 'origin.git');
  const seed = join(tmp, 'seed');
  const local = join(tmp, 'local');
  mkdirSync(origin, { recursive: true });
  g(['init', '-q', '-b', 'main', '--bare'], origin);
  mkdirSync(join(seed, 'shared', 'projects', 'foo'), { recursive: true });
  g(['init', '-q', '-b', 'main'], seed);
  g(['config', 'user.email', 'test@example.invalid'], seed);
  g(['config', 'user.name', 'test'], seed);
  writeFileSync(join(seed, 'README.md'), '# seed\n');
  for (const rel of sessions) {
    const abs = join(seed, 'shared', 'projects', 'foo', rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, '{"x":1}\n');
  }
  g(['add', '.'], seed);
  g(['commit', '-q', '-m', 'seed'], seed);
  g(['remote', 'add', 'origin', origin], seed);
  g(['push', '-q', 'origin', 'main'], seed);
  g(['clone', '-q', origin, local], tmp);
  return { local };
}

describe('sessionInPushedHistory / warnIfSessionPushed (real git)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-pushed-history-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns true for a flat <id>.jsonl present in pushed history', async () => {
    const { local } = buildPushedRepo(tmp, ['sid-flat.jsonl']);
    const { sessionInPushedHistory } = await import('./commands.pushed-history.ts');
    expect(sessionInPushedHistory('sid-flat', local)).toBe(true);
  });

  it('returns true for a <id>/ subtree present in pushed history', async () => {
    const { local } = buildPushedRepo(tmp, [join('sid-sub', 'agent.jsonl')]);
    const { sessionInPushedHistory } = await import('./commands.pushed-history.ts');
    expect(sessionInPushedHistory('sid-sub', local)).toBe(true);
  });

  it('returns true for a deeply nested <id>/ subtree file in pushed history', async () => {
    // The pathspec glob must match files more than one level below <id>/ (e.g.
    // subagents/ or tool-results/), so secrets in deep subtree files are not
    // missed. Guards against a future switch to `:(glob)` magic, under which
    // `*` would stop matching `/`.
    const { local } = buildPushedRepo(tmp, [join('sid-sub', 'subagents', 'agent.jsonl')]);
    const { sessionInPushedHistory } = await import('./commands.pushed-history.ts');
    expect(sessionInPushedHistory('sid-sub', local)).toBe(true);
  });

  it('returns false for a session absent from pushed history', async () => {
    const { local } = buildPushedRepo(tmp, ['sid-flat.jsonl']);
    const { sessionInPushedHistory } = await import('./commands.pushed-history.ts');
    expect(sessionInPushedHistory('sid-absent', local)).toBe(false);
  });

  it('returns false when the repo has no upstream (never pushed)', async () => {
    const solo = join(tmp, 'solo');
    mkdirSync(join(solo, 'shared', 'projects', 'foo'), { recursive: true });
    g(['init', '-q', '-b', 'main'], solo);
    g(['config', 'user.email', 'test@example.invalid'], solo);
    g(['config', 'user.name', 'test'], solo);
    writeFileSync(join(solo, 'shared', 'projects', 'foo', 'sid-flat.jsonl'), '{"x":1}\n');
    g(['add', '.'], solo);
    g(['commit', '-q', '-m', 'local only'], solo);
    const { sessionInPushedHistory } = await import('./commands.pushed-history.ts');
    expect(sessionInPushedHistory('sid-flat', solo)).toBe(false);
  });

  it('warnIfSessionPushed logs the remediation note only when in pushed history', async () => {
    const { local } = buildPushedRepo(tmp, ['sid-flat.jsonl']);
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      logged.push(String(m));
    });
    const { warnIfSessionPushed } = await import('./commands.pushed-history.ts');

    warnIfSessionPushed('sid-flat', local);
    warnIfSessionPushed('sid-absent', local);

    const hits = logged.filter((l) => l.includes('already in pushed history'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('rotate the credential');
  });
});

describe('sessionInPushedHistory (mocked child_process degrade paths)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns false when the upstream ref resolves empty', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(() => Buffer.from('\n')), // rev-parse @{u} -> empty
    }));
    const { sessionInPushedHistory } = await import('./commands.pushed-history.ts');
    expect(sessionInPushedHistory('sid', '/repo')).toBe(false);
    vi.doUnmock('node:child_process');
  });

  it('returns false when git log throws after a valid upstream ref', async () => {
    vi.resetModules();
    let call = 0;
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(() => {
        call += 1;
        if (call === 1) return Buffer.from('origin/main\n'); // rev-parse @{u}
        throw new Error('git log failed'); // log -- pathspec
      }),
    }));
    const { sessionInPushedHistory } = await import('./commands.pushed-history.ts');
    expect(sessionInPushedHistory('sid', '/repo')).toBe(false);
    vi.doUnmock('node:child_process');
  });
});
