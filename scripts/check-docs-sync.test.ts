import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

interface DocsSyncModule {
  evaluateDocsSync: (changed: string[]) => { ok: boolean; canaryChanged: boolean; reason: string };
  parseBase: (argv: string[]) => string;
  CANARY_FILES: string[];
  DOC_SURFACES: string[];
}

/** Loads the exports of scripts/check-docs-sync.cjs. */
function loadModule(): DocsSyncModule {
  return require('./check-docs-sync.cjs') as DocsSyncModule;
}

describe('evaluateDocsSync', () => {
  const { evaluateDocsSync } = loadModule();

  it('passes when no canary file changed', () => {
    const v = evaluateDocsSync(['src/commands.doctor.ts', 'src/utils.ts']);
    expect(v.ok).toBe(true);
    expect(v.canaryChanged).toBe(false);
  });

  it('fails when the canary changed but no doc surface did', () => {
    const v = evaluateDocsSync(['src/nomad.help.ts', 'src/commands.doctor.ts']);
    expect(v.ok).toBe(false);
    expect(v.canaryChanged).toBe(true);
    expect(v.reason).toMatch(/without a documentation update/);
  });

  it('passes when the canary changed and README.md changed', () => {
    expect(evaluateDocsSync(['src/nomad.help.ts', 'README.md']).ok).toBe(true);
  });

  it('passes when the canary changed and the docs-site command reference changed', () => {
    const v = evaluateDocsSync(['src/nomad.help.ts', 'docs-site/src/content/docs/commands.md']);
    expect(v.ok).toBe(true);
  });

  it('passes on an empty changed-file list', () => {
    expect(evaluateDocsSync([]).ok).toBe(true);
  });

  it('treats a non-array argument as no changes', () => {
    expect(evaluateDocsSync(undefined as unknown as string[]).ok).toBe(true);
  });
});

describe('parseBase', () => {
  const { parseBase } = loadModule();

  it('defaults to origin/main when --base is absent', () => {
    expect(parseBase([])).toBe('origin/main');
  });

  it('reads the value after --base', () => {
    expect(parseBase(['--base', 'abc123'])).toBe('abc123');
  });

  it('falls back to the default when --base has no value', () => {
    expect(parseBase(['--base'])).toBe('origin/main');
  });
});
