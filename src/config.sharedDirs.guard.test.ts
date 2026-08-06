import { describe, expect, it } from 'vitest';

import {
  assertSafeLogical,
  isValidSharedDir,
  validateSharedDirEntry,
} from './config.sharedDirs.guard.ts';

describe('assertSafeLogical (path-map logical key traversal guard)', () => {
  it('accepts a well-formed alphanumeric logical name', () => {
    expect(() => assertSafeLogical('ha-acwd')).not.toThrow();
  });

  it('accepts a logical name with dots and underscores', () => {
    expect(() => assertSafeLogical('project.name_v2')).not.toThrow();
  });

  it('accepts a short single-word logical name', () => {
    expect(() => assertSafeLogical('foo')).not.toThrow();
  });

  it('throws NomadFatal for "../escape" (directory traversal)', async () => {
    const { NomadFatal } = await import('./utils.ts');
    expect(() => assertSafeLogical('../escape')).toThrow(NomadFatal);
  });

  it('throws NomadFatal for "foo/bar" (path separator)', async () => {
    const { NomadFatal } = await import('./utils.ts');
    expect(() => assertSafeLogical('foo/bar')).toThrow(NomadFatal);
  });

  it('throws NomadFatal for "." (current-dir shorthand)', async () => {
    const { NomadFatal } = await import('./utils.ts');
    expect(() => assertSafeLogical('.')).toThrow(NomadFatal);
  });

  it('throws NomadFatal for ".." (parent-dir shorthand)', async () => {
    const { NomadFatal } = await import('./utils.ts');
    expect(() => assertSafeLogical('..')).toThrow(NomadFatal);
  });

  it('throws NomadFatal for empty string', async () => {
    const { NomadFatal } = await import('./utils.ts');
    expect(() => assertSafeLogical('')).toThrow(NomadFatal);
  });

  it('error message includes the invalid logical name', async () => {
    const { NomadFatal } = await import('./utils.ts');
    let caught: Error | undefined;
    try {
      assertSafeLogical('../escape');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect(caught?.message).toContain('../escape');
  });
});

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

  describe('non-string rejection (runtime-input safety)', () => {
    it('rejects a number that would otherwise string-coerce through the regex', () => {
      expect(isValidSharedDir(42)).toBe(false);
    });

    it('rejects null', () => {
      expect(isValidSharedDir(null)).toBe(false);
    });

    it('rejects undefined', () => {
      expect(isValidSharedDir(undefined)).toBe(false);
    });

    it('rejects an object', () => {
      expect(isValidSharedDir({ nested: 'x' })).toBe(false);
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

    it('rejects ".credentials.json" (OAuth credential store must never sync)', () => {
      expect(isValidSharedDir('.credentials.json')).toBe(false);
    });

    it('rejects host-local cache/runtime dirs (cache, backups, tasks)', () => {
      expect(isValidSharedDir('cache')).toBe(false);
      expect(isValidSharedDir('backups')).toBe(false);
      expect(isValidSharedDir('tasks')).toBe(false);
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

  describe('credential-shaped name rejection', () => {
    it('rejects ".env"', () => {
      expect(isValidSharedDir('.env')).toBe(false);
    });

    it('rejects "id_rsa"', () => {
      expect(isValidSharedDir('id_rsa')).toBe(false);
    });

    it('rejects "credentials"', () => {
      expect(isValidSharedDir('credentials')).toBe(false);
    });
  });
});

describe('validateSharedDirEntry (reason-returning companion to isValidSharedDir)', () => {
  describe('success', () => {
    it('returns null for a valid alphanumeric entry', () => {
      expect(validateSharedDirEntry('get-shit-done')).toBeNull();
    });

    it('returns null for a second valid entry (dots and underscores)', () => {
      expect(validateSharedDirEntry('my.tool_dir')).toBeNull();
    });
  });

  describe('not-a-string', () => {
    it.each([42, null, undefined, { nested: 'x' }])('rejects %p', (value) => {
      expect(validateSharedDirEntry(value)?.reason).toBe('not-a-string');
    });
  });

  describe('not-a-segment', () => {
    it.each(['foo/bar', '..', '.', '', 'foo\\bar', 'foo bar'])('rejects %p', (value) => {
      expect(validateSharedDirEntry(value)?.reason).toBe('not-a-segment');
    });
  });

  describe('never-sync', () => {
    it.each(['todos', '.credentials.json'])('rejects %p', (value) => {
      expect(validateSharedDirEntry(value)?.reason).toBe('never-sync');
    });
  });

  describe('reserved', () => {
    it.each(['hooks', 'path-map.json'])('rejects %p', (value) => {
      expect(validateSharedDirEntry(value)?.reason).toBe('reserved');
    });
  });

  describe('secret-shaped', () => {
    it.each([
      '.env',
      '.env.local',
      '.ENV',
      'id_rsa',
      'credentials',
      'server.pem',
      'deploy.key',
      '.npmrc',
    ])('rejects %p', (value) => {
      expect(validateSharedDirEntry(value)?.reason).toBe('secret-shaped');
    });

    it('returns the secret-shaped reason for ".env" with a message naming it', () => {
      expect(validateSharedDirEntry('.env')).toEqual({
        reason: 'secret-shaped',
        message: expect.stringContaining('credential-shaped') as string,
      });
    });
  });

  // On a case-insensitive filesystem (macOS default, NTFS) these resolve to the
  // same inode as their lowercase counterparts, so accepting one would let a
  // sharedDirs entry be symlinked over this host's per-host settings or its
  // OAuth credential store. `isDeniedName` folds case for exactly this reason;
  // the guard has to agree with it or it is the weaker of the two boundaries.
  describe('case-insensitive matching', () => {
    it.each(['Settings.local.json', 'SETTINGS.LOCAL.JSON', '.Credentials.json', 'Todos'])(
      'rejects mixed-case %p as never-sync',
      (value) => {
        expect(validateSharedDirEntry(value)?.reason).toBe('never-sync');
      },
    );

    it.each(['CLAUDE.MD', 'claude.md', 'Hooks', 'My-Statusline.cjs', 'Path-Map.json'])(
      'rejects mixed-case %p as reserved',
      (value) => {
        expect(validateSharedDirEntry(value)?.reason).toBe('reserved');
      },
    );

    it('still accepts a valid entry that differs only in case from nothing denied', () => {
      expect(validateSharedDirEntry('Get-Shit-Done')).toBeNull();
    });
  });
});
