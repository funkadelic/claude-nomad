import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

interface VerifyTarballModule {
  FORBIDDEN: RegExp;
  parseNpmPackJson: (text: string) => unknown;
}

/**
 * Loads the exports of scripts/verify-tarball.cjs.
 */
function loadModule(): VerifyTarballModule {
  return require('./verify-tarball.cjs') as VerifyTarballModule;
}

/**
 * Convenience accessor for the FORBIDDEN regex.
 */
function loadForbidden(): RegExp {
  return loadModule().FORBIDDEN;
}

describe('verify-tarball FORBIDDEN regex', () => {
  describe('newly added .claude-plugin exclusion', () => {
    it('matches .claude-plugin (exact)', () => {
      expect(loadForbidden().test('.claude-plugin')).toBe(true);
    });

    it('matches .claude-plugin/marketplace.json', () => {
      expect(loadForbidden().test('.claude-plugin/marketplace.json')).toBe(true);
    });

    it('matches nested path .claude-plugin/nomad-plugin/.claude-plugin/plugin.json', () => {
      expect(loadForbidden().test('.claude-plugin/nomad-plugin/.claude-plugin/plugin.json')).toBe(
        true,
      );
    });

    it('does not match a sibling name that merely starts with .claude-plugin (boundary check)', () => {
      // e.g. a hypothetical ".claude-pluginfoo" must NOT be swallowed by the guard
      expect(loadForbidden().test('.claude-pluginfoo')).toBe(false);
      expect(loadForbidden().test('.claude-pluginfoo/bar.json')).toBe(false);
    });
  });

  describe('pre-existing forbidden roots (regression guard)', () => {
    it.each([
      ['.planning/x'],
      ['.github/y'],
      ['src/nomad.ts'],
      ['scripts/verify-tarball.cjs'],
      ['docs-site/z'],
      ['tests/foo.test.ts'],
      ['node_modules/some-pkg/index.js'],
      ['hosts/myhost.json'],
      ['install.sh'],
      ['tsconfig.json'],
      ['vitest.config.ts'],
    ])('matches %s', (path) => {
      expect(loadForbidden().test(path)).toBe(true);
    });
  });

  describe('required shipped paths (must not over-match)', () => {
    it.each([
      ['dist/nomad.mjs'],
      ['dist/nomad.worker.mjs'],
      ['LICENSE'],
      ['README.md'],
      ['CHANGELOG.md'],
      ['package.json'],
      ['.gitleaks.toml'],
    ])('does not match %s', (path) => {
      expect(loadForbidden().test(path)).toBe(false);
    });
  });
});

describe('parseNpmPackJson', () => {
  it('parses a clean JSON array directly', () => {
    const input = JSON.stringify([{ files: [{ path: 'dist/nomad.mjs' }] }]);
    const result = loadModule().parseNpmPackJson(input);
    expect(result).toEqual([{ files: [{ path: 'dist/nomad.mjs' }] }]);
  });

  it('salvages the JSON array when npm prepends notice lines', () => {
    const arr = [{ files: [{ path: 'dist/nomad.mjs' }] }];
    const input = `npm notice created a tarball\n${JSON.stringify(arr)}`;
    const result = loadModule().parseNpmPackJson(input);
    expect(result).toEqual(arr);
  });

  it('throws when no JSON array is found', () => {
    expect(() => loadModule().parseNpmPackJson('not json at all')).toThrow(
      'no JSON array found in npm pack output',
    );
  });
});
