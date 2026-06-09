/**
 * Tests for `collectGlobalConfigChanges` (push-global-config.ts) and
 * `buildGlobalConfigSection` (commands.push.sections.ts).
 *
 * All tests stub `execFileSync` so the git invocation is offline.
 * Assertions are behavior-focused: returned rows and section shapes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as childProcessModule from 'node:child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a NUL-delimited name-status string from [status, path] pairs. */
function buildNameStatus(records: [string, string][]): string {
  return records.map(([s, p]) => `${s}\0${p}`).join('\0') + '\0';
}

/** Build a NUL-delimited name-status string with a rename record. */
function buildRenameStatus(oldPath: string, newPath: string, score = '100'): string {
  return `R${score}\0${oldPath}\0${newPath}\0`;
}

// ---------------------------------------------------------------------------
// collectGlobalConfigChanges
// ---------------------------------------------------------------------------

describe('collectGlobalConfigChanges', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
  });

  it('maps status A -> label "add"', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => buildNameStatus([['A', 'shared/skills/new.md']])),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([{ status: 'A', label: 'add', path: 'shared/skills/new.md' }]);
  });

  it('maps status M -> label "modify"', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => buildNameStatus([['M', 'shared/skills/existing.md']])),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([{ status: 'M', label: 'modify', path: 'shared/skills/existing.md' }]);
  });

  it('maps status D -> label "delete"', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => buildNameStatus([['D', 'shared/agents/old.md']])),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([{ status: 'D', label: 'delete', path: 'shared/agents/old.md' }]);
  });

  it('maps rename record (R) -> label "rename", surfaces new path', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() =>
          buildRenameStatus('shared/skills/old-name.md', 'shared/skills/new-name.md'),
        ),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([{ status: 'R', label: 'rename', path: 'shared/skills/new-name.md' }]);
  });

  it('returns [] on empty input (empty string)', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => ''),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([]);
  });

  it('returns [] on input that is only NUL', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => '\0'),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([]);
  });

  it('includes shared/skills/* (in-scope directory)', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => buildNameStatus([['M', 'shared/skills/foo.md']])),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([{ status: 'M', label: 'modify', path: 'shared/skills/foo.md' }]);
  });

  it('includes shared/agents/* (in-scope directory)', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => buildNameStatus([['A', 'shared/agents/my-agent.md']])),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([{ status: 'A', label: 'add', path: 'shared/agents/my-agent.md' }]);
  });

  it('includes shared/commands/* (in-scope directory)', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => buildNameStatus([['M', 'shared/commands/do-thing.md']])),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([{ status: 'M', label: 'modify', path: 'shared/commands/do-thing.md' }]);
  });

  it('includes shared/rules/* (in-scope directory)', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => buildNameStatus([['M', 'shared/rules/my-rule.md']])),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([{ status: 'M', label: 'modify', path: 'shared/rules/my-rule.md' }]);
  });

  it('includes shared/hooks/* (in-scope directory)', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => buildNameStatus([['A', 'shared/hooks/pre-push']])),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([{ status: 'A', label: 'add', path: 'shared/hooks/pre-push' }]);
  });

  it('includes shared/CLAUDE.md (in-scope file)', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => buildNameStatus([['M', 'shared/CLAUDE.md']])),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([{ status: 'M', label: 'modify', path: 'shared/CLAUDE.md' }]);
  });

  it('includes shared/my-statusline.cjs (in-scope file)', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => buildNameStatus([['M', 'shared/my-statusline.cjs']])),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([{ status: 'M', label: 'modify', path: 'shared/my-statusline.cjs' }]);
  });

  it('includes shared/settings.base.json (in-scope file)', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => buildNameStatus([['M', 'shared/settings.base.json']])),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([{ status: 'M', label: 'modify', path: 'shared/settings.base.json' }]);
  });

  it('includes hosts/<hostname>.json for the matching host', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => buildNameStatus([['M', 'hosts/myhost.json']])),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([{ status: 'M', label: 'modify', path: 'hosts/myhost.json' }]);
  });

  it('excludes hosts/<other>.json for a non-matching host', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => buildNameStatus([['M', 'hosts/otherhost.json']])),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([]);
  });

  it('excludes shared/projects/* paths (Sessions)', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() =>
          buildNameStatus([['M', 'shared/projects/my-project/session.jsonl']]),
        ),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([]);
  });

  it('excludes shared/extras/* paths (Extras)', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() =>
          buildNameStatus([['A', 'shared/extras/my-project/.planning/STATE.md']]),
        ),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([]);
  });

  it('excludes a bare "settings.json" at repo root (not in shared/)', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => buildNameStatus([['M', 'settings.json']])),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([]);
  });

  it('handles mixed in-scope and out-of-scope records correctly', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() =>
          buildNameStatus([
            ['M', 'shared/skills/foo.md'],
            ['M', 'shared/projects/proj/session.jsonl'],
            ['A', 'shared/extras/proj/.planning/todo.md'],
            ['M', 'hosts/myhost.json'],
          ]),
        ),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    const result = collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(result).toEqual([
      { status: 'M', label: 'modify', path: 'shared/skills/foo.md' },
      { status: 'M', label: 'modify', path: 'hosts/myhost.json' },
    ]);
  });

  it('uses --cached args when staged: true', async () => {
    let capturedArgs: string[] = [];
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_cmd: string, args: string[]) => {
          capturedArgs = [...args];
          return '';
        }),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    collectGlobalConfigChanges('/repo', 'myhost', { staged: true });
    expect(capturedArgs).toEqual(['diff', '--cached', '--name-status', '-z']);
  });

  it('uses HEAD args when staged: false', async () => {
    let capturedArgs: string[] = [];
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_cmd: string, args: string[]) => {
          capturedArgs = [...args];
          return '';
        }),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    collectGlobalConfigChanges('/repo', 'myhost', { staged: false });
    expect(capturedArgs).toEqual(['diff', 'HEAD', '--name-status', '-z']);
  });

  it('passes repoHome as cwd to execFileSync', async () => {
    let capturedCwd: string | undefined;
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_cmd: string, _args: string[], opts: { cwd?: string }) => {
          capturedCwd = opts.cwd;
          return '';
        }),
      };
    });
    const { collectGlobalConfigChanges } = await import('./push-global-config.ts');
    collectGlobalConfigChanges('/my/repo', 'myhost', { staged: true });
    expect(capturedCwd).toBe('/my/repo');
  });
});

// ---------------------------------------------------------------------------
// buildGlobalConfigSection
// ---------------------------------------------------------------------------

describe('buildGlobalConfigSection', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a section titled "Global config"', async () => {
    const { buildGlobalConfigSection } = await import('./commands.push.sections.ts');
    const result = buildGlobalConfigSection([]);
    expect(result.header).toBe('Global config');
  });

  it('returns a zero-item section for an empty rows array', async () => {
    const { buildGlobalConfigSection } = await import('./commands.push.sections.ts');
    const result = buildGlobalConfigSection([]);
    expect(result.items).toHaveLength(0);
  });

  it('produces one green-ok-glyph row per change with "<label> <path>" text', async () => {
    const { buildGlobalConfigSection } = await import('./commands.push.sections.ts');
    const rows = [
      { status: 'M', label: 'modify', path: 'shared/skills/foo.md' },
      { status: 'A', label: 'add', path: 'shared/hooks/pre-push' },
    ];
    const result = buildGlobalConfigSection(rows);
    expect(result.items).toHaveLength(2);
    // Each item should include the label and path text.
    expect(result.items[0]).toContain('modify');
    expect(result.items[0]).toContain('shared/skills/foo.md');
    expect(result.items[1]).toContain('add');
    expect(result.items[1]).toContain('shared/hooks/pre-push');
  });

  it('includes the ok glyph character in each row', async () => {
    const { buildGlobalConfigSection } = await import('./commands.push.sections.ts');
    const rows = [{ status: 'M', label: 'modify', path: 'shared/CLAUDE.md' }];
    const result = buildGlobalConfigSection(rows);
    // The ok glyph is ✓ (U+2713).
    expect(result.items[0]).toContain('✓');
  });
});
