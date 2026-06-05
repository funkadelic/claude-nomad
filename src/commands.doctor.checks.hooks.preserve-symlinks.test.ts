import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { infoGlyph, okGlyph, warnGlyph } from './color.ts';
import { type Env, makeDoctorEnv, restoreEnv } from './commands.doctor.checks.test-helpers.ts';

/**
 * Build the shared/hooks repo tree and symlink `~/.claude/hooks` to it,
 * mirroring the real topology that triggers the --preserve-symlinks-main bug.
 * Optionally write script files under the repo tree.
 *
 * @param testHome - Sandbox home from makeDoctorEnv.
 * @param files - Map of filename -> content to write under shared/hooks.
 */
function buildHookTree(testHome: string, files: Record<string, string> = {}): void {
  const sharedHooks = join(testHome, 'claude-nomad', 'shared', 'hooks');
  mkdirSync(sharedHooks, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(sharedHooks, name), content);
  }
  symlinkSync(sharedHooks, join(testHome, '.claude', 'hooks'));
}

/**
 * Write settings.json with the given hooks block into the sandbox.
 *
 * @param testHome - Sandbox home from makeDoctorEnv.
 * @param hooks - The hooks object to embed.
 */
function writeHooksSettings(testHome: string, hooks: unknown): void {
  writeFileSync(join(testHome, '.claude', 'settings.json'), JSON.stringify({ hooks }) + '\n');
}

/**
 * Run the reporter through a fresh module graph and return joined items.
 *
 * @returns Joined section items string.
 */
async function runCheck(): Promise<{ out: string; items: string[] }> {
  vi.resetModules();
  const { section } = await import('./commands.doctor.format.ts');
  const { reportPreserveSymlinksCheck } =
    await import('./commands.doctor.checks.hooks.preserve-symlinks.ts');
  const sec = section('Hook targets');
  reportPreserveSymlinksCheck(sec);
  return { out: sec.items.join('\n'), items: sec.items };
}

describe('reportPreserveSymlinksCheck', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = undefined;
    env = makeDoctorEnv({ host: 'test-host' });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Task 1: command-shape detection cases
  // -------------------------------------------------------------------------

  it('warns when node runs a .js script under symlinked hooks dir without --preserve-symlinks-main', async () => {
    // Script has a broken relative require (gsd-core/ does not exist in the repo tree)
    buildHookTree(env.testHome, {
      'run.js': `const pkg = require('../gsd-core/bin/lib/package-identity.cjs');\nmodule.exports = pkg;\n`,
    });
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ type: 'command', command: `node ~/.claude/hooks/run.js` }],
    });
    const { out } = await runCheck();
    expect(out).toContain(`${warnGlyph} hooks/PostToolUse:`);
    expect(out).toContain('--preserve-symlinks-main');
    expect(out).toContain('shared/settings.base.json');
    expect(process.exitCode).toBeUndefined();
  });

  it('does not warn when --preserve-symlinks-main is present in the command', async () => {
    buildHookTree(env.testHome, {
      'run.js': `const pkg = require('../gsd-core/bin/lib/package-identity.cjs');\nmodule.exports = pkg;\n`,
    });
    writeHooksSettings(env.testHome, {
      PostToolUse: [
        {
          type: 'command',
          command: `node --preserve-symlinks-main ~/.claude/hooks/run.js`,
        },
      ],
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not warn when the script does not resolve under a nomad-symlinked dir', async () => {
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ type: 'command', command: `node /usr/local/bin/other.js` }],
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not warn for a non-node command even if the script is under the hooks dir', async () => {
    buildHookTree(env.testHome, { 'run.sh': '#!/bin/sh\necho hi\n' });
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ type: 'command', command: `~/.claude/hooks/run.sh` }],
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not warn for bash wrapping a script under the hooks dir (not a node invocation)', async () => {
    buildHookTree(env.testHome, { 'x.sh': '' });
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ type: 'command', command: `bash ~/.claude/hooks/x.sh` }],
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits the ok summary when settings has hooks but no node-under-symlinked-dir commands', async () => {
    writeHooksSettings(env.testHome, {
      PreToolUse: [{ type: 'command', command: `echo hello` }],
    });
    const { out } = await runCheck();
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(out).not.toContain(`${warnGlyph}`);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits a dim info skip when settings.json is absent', async () => {
    // makeDoctorEnv does NOT write settings.json by default
    const { out } = await runCheck();
    expect(out).toContain(`${infoGlyph}`);
    expect(out).not.toContain(`${warnGlyph}`);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not throw and leaves exitCode undefined on malformed settings.json', async () => {
    writeFileSync(join(env.testHome, '.claude', 'settings.json'), '{ this is not json\n');
    let threw = false;
    try {
      await runCheck();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not throw and leaves exitCode undefined when settings.json contains literal null', async () => {
    writeFileSync(join(env.testHome, '.claude', 'settings.json'), 'null\n');
    let threw = false;
    try {
      await runCheck();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not throw and leaves exitCode undefined when hooks is not an object', async () => {
    writeHooksSettings(env.testHome, 'not-an-object');
    const { out } = await runCheck();
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('process.exitCode is undefined after a flagged (warn) case', async () => {
    buildHookTree(env.testHome, {
      'run.js': `const pkg = require('../gsd-core/bin/lib/package-identity.cjs');\nmodule.exports = pkg;\n`,
    });
    writeHooksSettings(env.testHome, {
      SessionStart: [{ type: 'command', command: `node ~/.claude/hooks/run.js` }],
    });
    await runCheck();
    expect(process.exitCode).toBeUndefined();
  });

  it('warns for a .cjs script under the symlinked dir without the flag', async () => {
    buildHookTree(env.testHome, {
      'lib.cjs': `const pkg = require('../gsd-core/bin/lib/package-identity.cjs');\nmodule.exports = pkg;\n`,
    });
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ type: 'command', command: `node ~/.claude/hooks/lib.cjs` }],
    });
    const { out } = await runCheck();
    expect(out).toContain(`${warnGlyph} hooks/PostToolUse:`);
    expect(out).toContain('--preserve-symlinks-main');
    expect(process.exitCode).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Task 2: require-probe layer cases
  // -------------------------------------------------------------------------

  it('warns when the script has a broken relative require (target missing from realpath dir)', async () => {
    // The script lives in shared/hooks/ (realpath); gsd-core/ does NOT exist
    // as a sibling of shared/ in the repo tree, so the require target is missing.
    buildHookTree(env.testHome, {
      'session-start.js': `const pkg = require('../gsd-core/bin/lib/package-identity.cjs');\nmodule.exports = pkg;\n`,
    });
    writeHooksSettings(env.testHome, {
      SessionStart: [{ type: 'command', command: `node ~/.claude/hooks/session-start.js` }],
    });
    const { out } = await runCheck();
    expect(out).toContain(`${warnGlyph} hooks/SessionStart:`);
    expect(out).toContain('--preserve-symlinks-main');
    expect(process.exitCode).toBeUndefined();
  });

  it('does not warn for a self-contained hook with bare-specifier requires only', async () => {
    buildHookTree(env.testHome, {
      'self-contained.js': `const fs = require('node:fs');\nconst pc = require('picocolors');\nmodule.exports = {};\n`,
    });
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ type: 'command', command: `node ~/.claude/hooks/self-contained.js` }],
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not warn for a self-contained hook with no requires at all', async () => {
    buildHookTree(env.testHome, {
      'no-requires.js': `console.log('hello');\n`,
    });
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ type: 'command', command: `node ~/.claude/hooks/no-requires.js` }],
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not warn when the relative-require target DOES exist relative to the realpath dir', async () => {
    // Materialize the sibling file in the repo tree: shared/sibling.cjs exists
    const sharedDir = join(env.testHome, 'claude-nomad', 'shared');
    writeFileSync(join(sharedDir, 'sibling.cjs'), 'module.exports = {};\n');
    buildHookTree(env.testHome, {
      'uses-sibling.js': `const s = require('../sibling.cjs');\nmodule.exports = s;\n`,
    });
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ type: 'command', command: `node ~/.claude/hooks/uses-sibling.js` }],
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not warn when a relative require is inside a comment (comment stripping applied)', async () => {
    // The require is in a line comment -> stripped -> no relative specifier found
    buildHookTree(env.testHome, {
      'commented.js': `// const x = require('../gsd-core/bin/lib/package-identity.cjs');\nmodule.exports = {};\n`,
    });
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ type: 'command', command: `node ~/.claude/hooks/commented.js` }],
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not warn when a relative require is inside a string literal (string stripping applied)', async () => {
    buildHookTree(env.testHome, {
      'string-require.js': `const s = "require('../gsd-core/bin/lib/package-identity.cjs')";\nmodule.exports = {};\n`,
    });
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ type: 'command', command: `node ~/.claude/hooks/string-require.js` }],
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('silently skips and leaves exitCode undefined when the script is unreadable', async () => {
    // Write a settings.json pointing at a non-existent script
    writeHooksSettings(env.testHome, {
      PostToolUse: [
        {
          type: 'command',
          command: `node ${join(env.testHome, '.claude', 'hooks', 'ghost.js')}`,
        },
      ],
    });
    // Create the hooks dir but NOT the script file, and create symlink
    const sharedHooks = join(env.testHome, 'claude-nomad', 'shared', 'hooks');
    mkdirSync(sharedHooks, { recursive: true });
    symlinkSync(sharedHooks, join(env.testHome, '.claude', 'hooks'));
    const { out } = await runCheck();
    // ghost.js does not exist on disk. realpathSync throws in
    // relativeRequireTargetsBroken -> returns false -> no WARN.
    expect(out).not.toContain(`${warnGlyph}`);
    expect(process.exitCode).toBeUndefined();
  });

  it('applies a bounded read to the script (does not read entire file unbounded)', async () => {
    // This is a structural test: the module must contain a slice/substring/line-cap
    // expression. Verified by the acceptance grep in the plan. This test confirms
    // the probe still works correctly on a large-ish file (100KB of filler + require).
    const filler = '// filler\n'.repeat(5000); // ~60KB
    const content = filler + `const x = require('../gsd-core/bin/lib/package-identity.cjs');\n`;
    buildHookTree(env.testHome, { 'large.js': content });
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ type: 'command', command: `node ~/.claude/hooks/large.js` }],
    });
    const { out } = await runCheck();
    // The require at byte ~60KB is within the 64KB bound, so it should be found.
    // Whether it warns depends on whether the target exists - it doesn't, so WARN.
    expect(out).toContain(`${warnGlyph} hooks/PostToolUse:`);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not warn when the broken require is past the 64KB read bound', async () => {
    // ~6600 repetitions of '// filler\n' (10 bytes each) = ~66000 bytes, past the 65536 bound.
    // The broken relative require placed after this filler must NOT be detected.
    const filler = '// filler\n'.repeat(6600);
    const content = filler + `const x = require('../gsd-core/bin/lib/package-identity.cjs');\n`;
    buildHookTree(env.testHome, { 'too-large.js': content });
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ type: 'command', command: `node ~/.claude/hooks/too-large.js` }],
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('handles the grouped hook shape ({ hooks: [...] } nested inside event array)', async () => {
    // Grouped format: each element of the event array has { hooks: [...] }
    buildHookTree(env.testHome, {
      'grouped.js': `const pkg = require('../gsd-core/bin/lib/package-identity.cjs');\nmodule.exports = pkg;\n`,
    });
    writeHooksSettings(env.testHome, {
      PostToolUse: [
        {
          hooks: [{ type: 'command', command: `node ~/.claude/hooks/grouped.js` }],
        },
      ],
    });
    const { out } = await runCheck();
    expect(out).toContain(`${warnGlyph} hooks/PostToolUse:`);
    expect(out).toContain('--preserve-symlinks-main');
    expect(process.exitCode).toBeUndefined();
  });

  it('silently skips null and non-object entries in a flat entry list', async () => {
    // Flat entry list with a null and a number mixed in with a valid command
    buildHookTree(env.testHome, {
      'ok.js': `const pkg = require('../gsd-core/bin/lib/package-identity.cjs');\nmodule.exports = pkg;\n`,
    });
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [null, 42, { type: 'command', command: `node ~/.claude/hooks/ok.js` }],
        },
      }) + '\n',
    );
    const { out } = await runCheck();
    // The valid entry should still be detected
    expect(out).toContain(`${warnGlyph} hooks/PostToolUse:`);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not warn when node is invoked without a .js/.cjs script arg', async () => {
    // `node somebin` or `node -e 'code'` -- no .js/.cjs path -> nodeScriptArg returns null
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ type: 'command', command: `node -e "console.log('hi')"` }],
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('warns when the script uses ESM static import with a broken relative specifier', async () => {
    // ESM import style: import ... from '../gsd-core/...'
    buildHookTree(env.testHome, {
      'esm-hook.js': `import pkg from '../gsd-core/bin/lib/package-identity.cjs';\nexport default pkg;\n`,
    });
    writeHooksSettings(env.testHome, {
      SessionStart: [{ type: 'command', command: `node ~/.claude/hooks/esm-hook.js` }],
    });
    const { out } = await runCheck();
    expect(out).toContain(`${warnGlyph} hooks/SessionStart:`);
    expect(out).toContain('--preserve-symlinks-main');
    expect(process.exitCode).toBeUndefined();
  });

  it('does not warn when the relative require resolves via extension probing (.js added)', async () => {
    // Specifier `require('../sibling')` where sibling.js exists (no extension in specifier)
    const sharedDir = join(env.testHome, 'claude-nomad', 'shared');
    writeFileSync(join(sharedDir, 'sibling.js'), 'module.exports = {};\n');
    buildHookTree(env.testHome, {
      'ext-probe.js': `const s = require('../sibling');\nmodule.exports = s;\n`,
    });
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ type: 'command', command: `node ~/.claude/hooks/ext-probe.js` }],
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('silently skips a hook group that is an object but neither grouped nor flat-command', async () => {
    // An object with no .hooks array and no .type === 'command' -> skipped
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ matcher: 'Bash', type: 'parallel' }],
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('silently skips flat entries with wrong type, null, and non-string command', async () => {
    // Covers commandsFromFlatEntries: null entry, non-object (number), wrong type, command not string
    writeHooksSettings(env.testHome, {
      PostToolUse: [
        {
          hooks: [
            null,
            42,
            { type: 'other', command: '/usr/bin/foo' },
            { type: 'command', command: 42 },
          ],
        },
      ],
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not warn when an ESM import specifier in a string literal resolves elsewhere', async () => {
    // An `import ... from '...'` inside a string literal must not be treated as a specifier
    buildHookTree(env.testHome, {
      'str-import.js': `const msg = "import pkg from '../gsd-core/bin/lib/x.cjs'";\nmodule.exports = {};\n`,
    });
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ type: 'command', command: `node ~/.claude/hooks/str-import.js` }],
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not warn when the relative require resolves via index file probing', async () => {
    // `require('../libdir')` where libdir/index.js exists
    const sharedDir = join(env.testHome, 'claude-nomad', 'shared');
    mkdirSync(join(sharedDir, 'libdir'), { recursive: true });
    writeFileSync(join(sharedDir, 'libdir', 'index.js'), 'module.exports = {};\n');
    buildHookTree(env.testHome, {
      'idx-probe.js': `const s = require('../libdir');\nmodule.exports = s;\n`,
    });
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ type: 'command', command: `node ~/.claude/hooks/idx-probe.js` }],
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('silently skips events whose groups value is not an array', async () => {
    // A hooks entry with a non-array value for the event key
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PostToolUse: 'not-an-array' } }) + '\n',
    );
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: preserve-symlinks-main not needed`);
    expect(process.exitCode).toBeUndefined();
  });

  it('tolerates a malformed path-map.json and still detects warnings', async () => {
    // Write a broken path-map.json; readPathMapSafe should fall back to { projects: {} }
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), '{ not valid json\n');
    buildHookTree(env.testHome, {
      'run.js': `const pkg = require('../gsd-core/bin/lib/package-identity.cjs');\nmodule.exports = pkg;\n`,
    });
    writeHooksSettings(env.testHome, {
      PostToolUse: [{ type: 'command', command: `node ~/.claude/hooks/run.js` }],
    });
    const { out } = await runCheck();
    // Falls back to static SHARED_LINKS, 'hooks' is still included -> still warns
    expect(out).toContain(`${warnGlyph} hooks/PostToolUse:`);
    expect(process.exitCode).toBeUndefined();
  });
});
