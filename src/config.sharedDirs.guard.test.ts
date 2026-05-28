import { describe, expect, it } from 'vitest';

import { isValidSharedDir } from './config.sharedDirs.guard.ts';

describe('isValidSharedDir (sharedDirs path-traversal and collision guard)', () => {
  describe('valid single-segment entries', () => {
    it('accepts a well-formed alphanumeric segment', () => {
      expect(isValidSharedDir('get-shit-done')).toBe(true);
    });

    it('accepts a segment with dots and underscores', () => {
      expect(isValidSharedDir('my.tool_dir')).toBe(true);
    });

    it('accepts a short alphabetic segment', () => {
      expect(isValidSharedDir('foo')).toBe(true);
    });
  });

  describe('path traversal rejection', () => {
    it('rejects a segment containing a forward slash', () => {
      expect(isValidSharedDir('foo/bar')).toBe(false);
    });

    it('rejects ".."', () => {
      expect(isValidSharedDir('..')).toBe(false);
    });

    it('rejects "."', () => {
      expect(isValidSharedDir('.')).toBe(false);
    });

    it('rejects a segment starting with "../" (traversal prefix)', () => {
      expect(isValidSharedDir('../escape')).toBe(false);
    });

    it('rejects an empty string', () => {
      expect(isValidSharedDir('')).toBe(false);
    });

    it('rejects a segment with a backslash', () => {
      expect(isValidSharedDir('foo\\bar')).toBe(false);
    });

    it('rejects a segment with a space', () => {
      expect(isValidSharedDir('foo bar')).toBe(false);
    });
  });

  describe('NEVER_SYNC rejection', () => {
    it('rejects "todos" (NEVER_SYNC segment)', () => {
      expect(isValidSharedDir('todos')).toBe(false);
    });

    it('rejects "settings.local.json" (NEVER_SYNC segment)', () => {
      expect(isValidSharedDir('settings.local.json')).toBe(false);
    });

    it('rejects "debug" (NEVER_SYNC segment)', () => {
      expect(isValidSharedDir('debug')).toBe(false);
    });

    it('rejects "ide" (NEVER_SYNC segment)', () => {
      expect(isValidSharedDir('ide')).toBe(false);
    });

    it('rejects "telemetry" (NEVER_SYNC segment)', () => {
      expect(isValidSharedDir('telemetry')).toBe(false);
    });
  });

  describe('reserved shared/ name rejection', () => {
    it('rejects "hooks" (reserved SHARED_LINKS member)', () => {
      expect(isValidSharedDir('hooks')).toBe(false);
    });

    it('rejects "agents" (reserved SHARED_LINKS member)', () => {
      expect(isValidSharedDir('agents')).toBe(false);
    });

    it('rejects "skills" (reserved SHARED_LINKS member)', () => {
      expect(isValidSharedDir('skills')).toBe(false);
    });

    it('rejects "commands" (reserved SHARED_LINKS member)', () => {
      expect(isValidSharedDir('commands')).toBe(false);
    });

    it('rejects "rules" (reserved SHARED_LINKS member)', () => {
      expect(isValidSharedDir('rules')).toBe(false);
    });

    it('rejects "hosts" (reserved repo-structural name)', () => {
      expect(isValidSharedDir('hosts')).toBe(false);
    });

    it('rejects "projects" (reserved repo-structural name)', () => {
      expect(isValidSharedDir('projects')).toBe(false);
    });

    it('rejects "extras" (reserved repo-structural name)', () => {
      expect(isValidSharedDir('extras')).toBe(false);
    });

    it('rejects "settings.base.json" (reserved shared/ file)', () => {
      expect(isValidSharedDir('settings.base.json')).toBe(false);
    });

    it('rejects "CLAUDE.md" (reserved shared/ file)', () => {
      expect(isValidSharedDir('CLAUDE.md')).toBe(false);
    });

    it('rejects "my-statusline.cjs" (reserved shared/ file)', () => {
      expect(isValidSharedDir('my-statusline.cjs')).toBe(false);
    });

    it('rejects "path-map.json" (reserved shared/ file)', () => {
      expect(isValidSharedDir('path-map.json')).toBe(false);
    });
  });
});
