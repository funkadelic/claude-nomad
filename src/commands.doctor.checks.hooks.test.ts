import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { failGlyph, infoGlyph, okGlyph } from './color.ts';
import { type Env, makeDoctorEnv, restoreEnv } from './commands.doctor.checks.test-helpers.ts';

/**
 * Build a Hook-targets section, run the reporter through a fresh module graph,
 * and return the section items joined for assertion.
 */
async function runCheck(): Promise<{ out: string; items: string[] }> {
  vi.resetModules();
  const { section } = await import('./commands.doctor.format.ts');
  const { reportHooksTargetCheck } = await import('./commands.doctor.checks.hooks.ts');
  const sec = section('Hook targets');
  reportHooksTargetCheck(sec);
  return { out: sec.items.join('\n'), items: sec.items };
}

/**
 * Write `~/.claude/settings.json` in the sandbox with the given object.
 *
 * @param testHome - The sandbox home directory from `makeDoctorEnv`.
 * @param obj - JSON-serialisable settings content.
 */
function writeSettings(testHome: string, obj: Record<string, unknown>): void {
  writeFileSync(join(testHome, '.claude', 'settings.json'), JSON.stringify(obj) + '\n');
}

/**
 * Create a hook script file in the sandbox at `~/.claude/<relPath>`.
 *
 * @param testHome - The sandbox home directory.
 * @param relPath - Path relative to `~/.claude/` (e.g. `hooks/foo.sh`).
 */
function touchScript(testHome: string, relPath: string): void {
  const abs = join(testHome, '.claude', relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, '#!/bin/sh\n');
}

describe('reportHooksTargetCheck', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    env = makeDoctorEnv({ host: 'test-host' });
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('emits an info skip line when settings.json is absent', async () => {
    const { out } = await runCheck();
    expect(out).toContain(`${infoGlyph} no ~/.claude/settings.json; skipping hook target check`);
    expect(process.exitCode).toBe(0);
  });

  it('emits OK when settings.json has no hooks key', async () => {
    writeSettings(env.testHome, { model: 'sonnet' });
    const { out } = await runCheck();
    expect(out).toContain(`${okGlyph} hooks: all command targets present`);
    expect(process.exitCode).toBe(0);
  });

  it('emits OK when hooks block is present but all resolvable targets exist ($HOME prefix)', async () => {
    touchScript(env.testHome, 'hooks/foo.sh');
    writeSettings(env.testHome, {
      hooks: {
        PostToolUse: [{ type: 'command', command: `$HOME/.claude/hooks/foo.sh` }],
      },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${okGlyph} hooks: all command targets present`);
    expect(process.exitCode).toBe(0);
  });

  it('emits OK when hooks block is present but all resolvable targets exist (tilde prefix)', async () => {
    touchScript(env.testHome, 'hooks/foo.sh');
    writeSettings(env.testHome, {
      hooks: {
        PostToolUse: [{ type: 'command', command: `~/.claude/hooks/foo.sh` }],
      },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${okGlyph} hooks: all command targets present`);
    expect(process.exitCode).toBe(0);
  });

  it('FAILs when ~/.claude target is missing (tilde prefix)', async () => {
    writeSettings(env.testHome, {
      hooks: {
        PostToolUse: [{ type: 'command', command: `~/.claude/hooks/missing.sh` }],
      },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${failGlyph} hooks/PostToolUse: command target missing:`);
    expect(out).toContain('missing.sh');
    expect(process.exitCode).toBe(1);
  });

  it('FAILs and names the event when target is missing ($HOME prefix)', async () => {
    writeSettings(env.testHome, {
      hooks: {
        SessionStart: [{ type: 'command', command: `$HOME/.claude/hooks/on-start.sh` }],
      },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${failGlyph} hooks/SessionStart: command target missing:`);
    expect(out).toContain('on-start.sh');
    expect(process.exitCode).toBe(1);
  });

  it('FAILs when target is missing (${HOME} prefix)', async () => {
    writeSettings(env.testHome, {
      hooks: {
        PreToolUse: [{ type: 'command', command: `\${HOME}/.claude/hooks/pre.sh` }],
      },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${failGlyph} hooks/PreToolUse: command target missing:`);
    expect(process.exitCode).toBe(1);
  });

  it('FAILs when target is missing (absolute CLAUDE_HOME prefix)', async () => {
    // Use actual CLAUDE_HOME which is based on the real HOME constant.
    // We write settings pointing at a path in the live CLAUDE_HOME, which
    // does not exist in the test sandbox. The module reads CLAUDE_HOME at
    // import time; after vi.resetModules() it re-evaluates with the env HOME
    // set to testHome, so both CLAUDE_HOME and the path will use testHome.
    const testClaudeHome = join(env.testHome, '.claude');
    writeSettings(env.testHome, {
      hooks: {
        Stop: [{ type: 'command', command: `${testClaudeHome}/hooks/stop.sh` }],
      },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${failGlyph} hooks/Stop: command target missing:`);
    expect(out).toContain('stop.sh');
    expect(process.exitCode).toBe(1);
  });

  it('emits one FAIL per missing target across multiple events', async () => {
    writeSettings(env.testHome, {
      hooks: {
        EventA: [{ type: 'command', command: `~/.claude/hooks/a.sh` }],
        EventB: [{ type: 'command', command: `~/.claude/hooks/b.sh` }],
      },
    });
    const { items } = await runCheck();
    const failLines = items.filter((l) => l.includes(failGlyph));
    expect(failLines.length).toBe(2);
    expect(failLines.some((l) => l.includes('EventA'))).toBe(true);
    expect(failLines.some((l) => l.includes('EventB'))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('skips a bare-binary command (no ~/.claude path) without emitting a line', async () => {
    writeSettings(env.testHome, {
      hooks: {
        PostToolUse: [{ type: 'command', command: 'jq -r .foo' }],
      },
    });
    const { items } = await runCheck();
    const nonOkItems = items.filter((l) => !l.includes(okGlyph));
    expect(nonOkItems).toHaveLength(0);
    expect(process.exitCode).toBe(0);
  });

  it('skips an unresolved env-var path without emitting a FAIL', async () => {
    writeSettings(env.testHome, {
      hooks: {
        PostToolUse: [{ type: 'command', command: '$UNRESOLVED_VAR/x.sh' }],
      },
    });
    const { out } = await runCheck();
    expect(out).not.toContain(failGlyph);
    expect(out).toContain(okGlyph);
    expect(process.exitCode).toBe(0);
  });

  it('ignores non-command hook entries (e.g. type !== "command")', async () => {
    writeSettings(env.testHome, {
      hooks: {
        PostToolUse: [{ type: 'mcp', server: 'my-server', tool: 'hook' }],
      },
    });
    const { out } = await runCheck();
    expect(out).not.toContain(failGlyph);
    expect(out).toContain(okGlyph);
    expect(process.exitCode).toBe(0);
  });

  it('tolerates grouped shape { hooks: HookEntry[] } and resolves targets within it', async () => {
    writeSettings(env.testHome, {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: `~/.claude/hooks/on-edit.sh` }],
          },
        ],
      },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${failGlyph} hooks/PostToolUse: command target missing:`);
    expect(out).toContain('on-edit.sh');
    expect(process.exitCode).toBe(1);
  });

  it('tolerates malformed entries (non-object group) without throwing', async () => {
    writeSettings(env.testHome, {
      hooks: {
        PostToolUse: [null, 42, 'string'],
      },
    });
    const { out } = await runCheck();
    expect(out).not.toContain(failGlyph);
    expect(out).toContain(okGlyph);
    expect(process.exitCode).toBe(0);
  });

  it('records a FAIL on malformed settings.json', async () => {
    writeFileSync(join(env.testHome, '.claude', 'settings.json'), '{ not json\n');
    const { out } = await runCheck();
    expect(out).toContain(failGlyph);
    expect(out).toContain('malformed JSON');
  });
});
