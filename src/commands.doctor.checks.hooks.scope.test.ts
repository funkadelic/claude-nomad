import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { infoGlyph, okGlyph, warnGlyph } from './color.ts';
import { type Env, makeDoctorEnv, restoreEnv } from './commands.doctor.checks.test-helpers.ts';

/**
 * Build a Hook-targets section, run the module-scope reporter through a fresh
 * module graph (mandatory: `color.ts` and `config.ts` read env at import time),
 * and return the section items joined for assertion.
 */
async function runCheck(): Promise<{ out: string; items: string[] }> {
  vi.resetModules();
  const { section } = await import('./commands.doctor.format.ts');
  const { reportHookScopeCheck } = await import('./commands.doctor.checks.hooks.scope.ts');
  const sec = section('Hook targets');
  reportHookScopeCheck(sec);
  return { out: sec.items.join('\n'), items: sec.items };
}

/**
 * Materialize a `shared/hooks/` repo tree in the sandbox and symlink
 * `~/.claude/hooks` to it so `realpathSync` resolves into the repo tree (the
 * exact bug topology). Writes an optional repo-root `package.json` and an
 * optional `shared/hooks/package.json` shim, then writes each named hook file.
 *
 * @param testHome - The sandbox home from `makeDoctorEnv`.
 * @param opts - Controllable ancestor types plus the hook files to write.
 */
function buildHookTree(
  testHome: string,
  opts: {
    rootType?: 'module' | 'commonjs';
    rootMalformed?: boolean;
    hooksType?: 'module' | 'commonjs';
    files?: Record<string, string>;
  },
): void {
  const repoHome = join(testHome, 'claude-nomad');
  const sharedHooks = join(repoHome, 'shared', 'hooks');
  mkdirSync(sharedHooks, { recursive: true });
  if (opts.rootMalformed === true) {
    writeFileSync(join(repoHome, 'package.json'), '{ this is not json\n');
  } else if (opts.rootType !== undefined) {
    writeFileSync(join(repoHome, 'package.json'), JSON.stringify({ type: opts.rootType }) + '\n');
  }
  if (opts.hooksType !== undefined) {
    writeFileSync(
      join(sharedHooks, 'package.json'),
      JSON.stringify({ type: opts.hooksType }) + '\n',
    );
  }
  for (const [name, body] of Object.entries(opts.files ?? {})) {
    writeFileSync(join(sharedHooks, name), body);
  }
  symlinkSync(sharedHooks, join(testHome, '.claude', 'hooks'));
}

describe('reportHookScopeCheck', () => {
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

  it('warns on CJS-as-ESM: a require() hook under a realpath ancestor type:module', async () => {
    buildHookTree(env.testHome, {
      rootType: 'module',
      files: { 'foo.js': 'const y = require("y");\nmodule.exports = y;\n' },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${warnGlyph} hooks/foo.js:`);
    expect(out).toContain('cjs source loads as esm');
    expect(process.exitCode).toBe(0);
  });

  it('warns on ESM-as-CJS: an import/export hook under a {type:commonjs} shim', async () => {
    buildHookTree(env.testHome, {
      hooksType: 'commonjs',
      files: { 'bar.js': 'import { z } from "z";\nexport const ok = z;\n' },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${warnGlyph} hooks/bar.js:`);
    expect(out).toContain('esm source loads as cjs');
    expect(process.exitCode).toBe(0);
  });

  it('realpath governs: a {type:commonjs} next to the symlink is ignored', async () => {
    // The realpath ancestor (repo root type:module) wins over any package.json
    // sitting beside the symlink under ~/.claude; a CJS hook there WARNs.
    const claudeDir = join(env.testHome, '.claude');
    writeFileSync(join(claudeDir, 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n');
    buildHookTree(env.testHome, {
      rootType: 'module',
      files: { 'baz.js': 'const y = require("y");\n' },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${warnGlyph} hooks/baz.js:`);
    expect(out).toContain('cjs source loads as esm');
    expect(process.exitCode).toBe(0);
  });

  it('skips .cjs and .mjs by extension under a conflicting ancestor', async () => {
    buildHookTree(env.testHome, {
      rootType: 'module',
      files: {
        'a.cjs': 'const y = require("y");\n',
        'b.mjs': 'import { z } from "z";\n',
      },
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: module type consistent`);
    expect(process.exitCode).toBe(0);
  });

  it('is green when consistent: a CJS hook under a CJS effective type', async () => {
    buildHookTree(env.testHome, {
      hooksType: 'commonjs',
      files: { 'ok.js': 'const y = require("y");\nmodule.exports = y;\n' },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${okGlyph} hooks: module type consistent`);
    expect(out).not.toContain(`${warnGlyph}`);
    expect(process.exitCode).toBe(0);
  });

  it('standalone no-shim: a plain CJS .js hook with no root package.json is green', async () => {
    buildHookTree(env.testHome, {
      files: { 'plain.js': 'const y = require("y");\n' },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${okGlyph} hooks: module type consistent`);
    expect(process.exitCode).toBe(0);
  });

  it('warns ESM-as-CJS without shim: an ESM hook with no package.json in the chain', async () => {
    // Topology-independent: absent type defaults to cjs, so ESM source WARNs.
    buildHookTree(env.testHome, {
      files: { 'esm.js': 'export const ok = 1;\n' },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${warnGlyph} hooks/esm.js:`);
    expect(out).toContain('esm source loads as cjs');
    expect(process.exitCode).toBe(0);
  });

  it('does not treat a dynamic import() in a CJS hook as ESM', async () => {
    buildHookTree(env.testHome, {
      hooksType: 'commonjs',
      files: { 'dyn.js': 'async function f() { const m = await import("x"); return m; }\n' },
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: module type consistent`);
    expect(process.exitCode).toBe(0);
  });

  it('ignores the word import inside a comment', async () => {
    buildHookTree(env.testHome, {
      hooksType: 'commonjs',
      files: { 'cmt.js': '// import the config first\nconst y = require("y");\n' },
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: module type consistent`);
    expect(process.exitCode).toBe(0);
  });

  it('does not let a // inside a double-quoted string swallow a later export', async () => {
    // WR-01 regression: comment-stripping must not run ahead of string-stripping,
    // or the // inside "http://x" eats the rest of the line and hides the export.
    buildHookTree(env.testHome, {
      hooksType: 'commonjs',
      files: { 'url.js': 'const u = "http://example.com";\nexport const ok = u;\n' },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${warnGlyph} hooks/url.js`);
    expect(process.exitCode).toBe(0);
  });

  it('strips single-quoted strings so a quoted marker is not miscounted', async () => {
    buildHookTree(env.testHome, {
      rootType: 'module',
      files: { 'sq.js': "const y = require('y');\nmodule.exports = y;\n" },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${warnGlyph} hooks/sq.js`);
    expect(process.exitCode).toBe(0);
  });

  it('strips backtick template literals so a templated marker is ignored', async () => {
    buildHookTree(env.testHome, {
      hooksType: 'commonjs',
      files: { 'tpl.js': 'const s = `nothing to require here`;\nexport const a = 1;\n' },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${warnGlyph} hooks/tpl.js`);
    expect(process.exitCode).toBe(0);
  });

  it('emits a dim info skip when ~/.claude/hooks is absent', async () => {
    const { out } = await runCheck();
    expect(out).toContain(`${infoGlyph} no ~/.claude/hooks; skipping module-scope check`);
    expect(process.exitCode).toBe(0);
  });

  it('tolerates a malformed package.json in the chain (no throw, degrades to cjs)', async () => {
    buildHookTree(env.testHome, {
      rootMalformed: true,
      files: { 'm.js': 'const y = require("y");\n' },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${okGlyph} hooks: module type consistent`);
    expect(process.exitCode).toBe(0);
  });

  it('classifies a require + leading export tie as cjs (CJS wins)', async () => {
    // require() + a leading export in one file -> classified cjs, so under a
    // cjs effective type it stays green (no false ESM WARN).
    buildHookTree(env.testHome, {
      hooksType: 'commonjs',
      files: { 'tie.js': 'export const a = 1;\nconst y = require("y");\n' },
    });
    const { out } = await runCheck();
    expect(out).toContain(`${okGlyph} hooks: module type consistent`);
    expect(out).not.toContain(`${warnGlyph}`);
    expect(process.exitCode).toBe(0);
  });

  it('skips an unknown-source hook with no module markers', async () => {
    // A shebang-only / shell-style hook has no JS module markers -> skip, and
    // with no other .js hooks the OK summary still fires.
    buildHookTree(env.testHome, {
      rootType: 'module',
      files: { 'sh.js': '#!/bin/sh\necho hello\n' },
    });
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: module type consistent`);
    expect(process.exitCode).toBe(0);
  });

  it('degrades to a skip when a hook is a broken symlink (realpath throws)', async () => {
    const repoHome = join(env.testHome, 'claude-nomad');
    const sharedHooks = join(repoHome, 'shared', 'hooks');
    mkdirSync(sharedHooks, { recursive: true });
    // A .js entry pointing at a nonexistent target: realpathSync throws ->
    // effective type is the skip signal, so the file is silently skipped.
    symlinkSync(join(sharedHooks, 'nope-target.js'), join(sharedHooks, 'broken.js'));
    symlinkSync(sharedHooks, join(env.testHome, '.claude', 'hooks'));
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: module type consistent`);
    expect(process.exitCode).toBe(0);
  });

  it('degrades to an empty list when readdirSync throws (hooks is a file)', async () => {
    // ~/.claude/hooks exists (existsSync true) but is a regular file, so
    // readdirSync throws ENOTDIR; safeReaddir degrades to [] and the OK
    // summary still fires.
    writeFileSync(join(env.testHome, '.claude', 'hooks'), 'not a directory\n');
    const { out } = await runCheck();
    expect(out).toContain(`${okGlyph} hooks: module type consistent`);
    expect(out).not.toContain(`${warnGlyph}`);
    expect(process.exitCode).toBe(0);
  });

  it('skips a .js hook whose realpath is a directory (read throws)', async () => {
    // A .js symlink pointing at a directory: realpathSync resolves (effective
    // type computes), but readFileSync throws EISDIR; safeRead degrades to null
    // and the file is silently skipped.
    const repoHome = join(env.testHome, 'claude-nomad');
    const sharedHooks = join(repoHome, 'shared', 'hooks');
    mkdirSync(join(sharedHooks, 'adir'), { recursive: true });
    symlinkSync(join(sharedHooks, 'adir'), join(sharedHooks, 'dir.js'));
    symlinkSync(sharedHooks, join(env.testHome, '.claude', 'hooks'));
    const { out } = await runCheck();
    expect(out).not.toContain(`${warnGlyph}`);
    expect(out).toContain(`${okGlyph} hooks: module type consistent`);
    expect(process.exitCode).toBe(0);
  });

  it('emits info skip and never throws when the hooks dir is unreadable', async () => {
    // ~/.claude/hooks is a dangling symlink: existsSync is false, so the
    // info-skip path fires (covers the existsSync-false branch with a symlink).
    symlinkSync(
      join(env.testHome, 'claude-nomad', 'shared', 'hooks'),
      join(env.testHome, '.claude', 'hooks'),
    );
    const { out } = await runCheck();
    expect(out).toContain(`${infoGlyph} no ~/.claude/hooks; skipping module-scope check`);
    expect(process.exitCode).toBe(0);
  });
});
