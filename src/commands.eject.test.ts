import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { cmdEject, EJECT_CHECKLIST } from './commands.eject.ts';

/**
 * Helper: create a temp directory pair (claudeHome + repoHome) for each test.
 */
function makeTempRoots(): { claudeHome: string; repoHome: string } {
  const base = mkdtempSync(join(tmpdir(), 'nomad-eject-'));
  const claudeHome = join(base, 'claude');
  const repoHome = join(base, 'repo');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(join(repoHome, 'shared'), { recursive: true });
  return { claudeHome, repoHome };
}

/**
 * Helper: write a real file in repoHome/shared/<name> and symlink
 * claudeHome/<name> to it. Returns the shared target path.
 */
function makeLinkedFile(
  claudeHome: string,
  repoHome: string,
  name: string,
  content = 'content',
): string {
  const target = join(repoHome, 'shared', name);
  writeFileSync(target, content);
  symlinkSync(target, join(claudeHome, name));
  return target;
}

/**
 * Helper: write a real directory in repoHome/shared/<name> with nested files,
 * and symlink claudeHome/<name> to it. Returns the target and nested file paths.
 */
function makeLinkedDir(
  claudeHome: string,
  repoHome: string,
  name: string,
): { target: string; nestedFile: string } {
  const target = join(repoHome, 'shared', name);
  mkdirSync(target, { recursive: true });
  const nestedFile = join(target, 'nested.md');
  writeFileSync(nestedFile, `# ${name}`);
  symlinkSync(target, join(claudeHome, name));
  return { target, nestedFile };
}

/**
 * Snapshot the mtimes of all direct children of a directory. Used to assert
 * repoHome is untouched after eject.
 */
function snapshotDir(dir: string): Map<string, number> {
  const entries = readdirSync(dir, { withFileTypes: true });
  const map = new Map<string, number>();
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      map.set(e.name, lstatSync(p).mtimeMs);
    } catch {
      map.set(e.name, -1);
    }
  }
  return map;
}

/**
 * Collect all console.log calls into a single newline-joined string.
 */
function allLogs(spy: MockInstance<(msg: string) => void>): string {
  return spy.mock.calls.map((c) => c[0]).join('\n');
}

describe('cmdEject', () => {
  let logSpy: MockInstance<(msg: string) => void>;
  let errSpy: MockInstance<(msg: string) => void>;
  let exitSpy: MockInstance<(code?: string | number | null) => never>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation((_msg: string) => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation((_msg: string) => undefined);
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null): never => {
        throw new Error(`process.exit(${String(code ?? 'undefined')})`);
      });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('materialize: symlinked file becomes a real file with target contents', () => {
    const { claudeHome, repoHome } = makeTempRoots();
    makeLinkedFile(claudeHome, repoHome, 'CLAUDE.md', 'hello world');

    cmdEject({}, { claudeHome, repoHome });

    const linkPath = join(claudeHome, 'CLAUDE.md');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(linkPath, 'utf8')).toBe('hello world');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ejected: CLAUDE.md'));
  });

  it('materialize dir: symlinked directory becomes a real directory tree', () => {
    const { claudeHome, repoHome } = makeTempRoots();
    const { nestedFile } = makeLinkedDir(claudeHome, repoHome, 'skills');

    cmdEject({}, { claudeHome, repoHome });

    const linkPath = join(claudeHome, 'skills');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(lstatSync(linkPath).isDirectory()).toBe(true);
    const nestedContents = readFileSync(join(claudeHome, 'skills', 'nested.md'), 'utf8');
    expect(nestedContents).toBe('# skills');
    expect(readFileSync(nestedFile, 'utf8')).toBe('# skills');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ejected: skills'));
  });

  it('skip-real: already-real file is left untouched and reported', () => {
    const { claudeHome, repoHome } = makeTempRoots();
    const realPath = join(claudeHome, 'CLAUDE.md');
    writeFileSync(realPath, 'already real');

    cmdEject({}, { claudeHome, repoHome });

    expect(lstatSync(realPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(realPath, 'utf8')).toBe('already real');
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('skipped (not a symlink): CLAUDE.md'),
    );
  });

  it('skip-absent: absent name is reported as skipped and not created', () => {
    const { claudeHome, repoHome } = makeTempRoots();

    cmdEject({}, { claudeHome, repoHome });

    expect(existsSync(join(claudeHome, 'CLAUDE.md'))).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('skipped (absent): CLAUDE.md'));
  });

  it('dangling FAIL: aborts with exit 1 before any mutation', () => {
    const { claudeHome, repoHome } = makeTempRoots();
    // Dangling: target does not exist
    symlinkSync(join(repoHome, 'shared', 'CLAUDE.md'), join(claudeHome, 'CLAUDE.md'));
    // Valid symlink that must NOT be materialized (abort precedes all mutation)
    makeLinkedFile(claudeHome, repoHome, 'my-statusline.cjs', 'module.exports = {}');

    expect(() => cmdEject({}, { claudeHome, repoHome })).toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('dangling'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('nomad pull'));
    // my-statusline.cjs must still be a symlink
    expect(lstatSync(join(claudeHome, 'my-statusline.cjs')).isSymbolicLink()).toBe(true);
  });

  it('dangling FAIL: error message includes the dangling name', () => {
    const { claudeHome, repoHome } = makeTempRoots();
    symlinkSync('/nonexistent/CLAUDE.md', join(claudeHome, 'CLAUDE.md'));

    expect(() => cmdEject({}, { claudeHome, repoHome })).toThrow('process.exit(1)');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('CLAUDE.md'));
  });

  it('dry-run: skip-real names are reported as not-a-symlink in dry-run output', () => {
    const { claudeHome, repoHome } = makeTempRoots();
    writeFileSync(join(claudeHome, 'CLAUDE.md'), 'already real');

    cmdEject({ dryRun: true }, { claudeHome, repoHome });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('skipped (not a symlink): CLAUDE.md'),
    );
    // File must be unchanged
    expect(readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf8')).toBe('already real');
  });

  it('dry-run: logs would-materialize without mutating symlinks', () => {
    const { claudeHome, repoHome } = makeTempRoots();
    makeLinkedFile(claudeHome, repoHome, 'CLAUDE.md', 'dry content');

    cmdEject({ dryRun: true }, { claudeHome, repoHome });

    expect(lstatSync(join(claudeHome, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('would materialize: CLAUDE.md'));
  });

  it('dry-run: prints the checklist', () => {
    const { claudeHome, repoHome } = makeTempRoots();
    makeLinkedFile(claudeHome, repoHome, 'CLAUDE.md');

    cmdEject({ dryRun: true }, { claudeHome, repoHome });

    const out = allLogs(logSpy);
    expect(out).toContain('npm uninstall -g claude-nomad');
    expect(out).toContain('NOMAD_HOST');
  });

  it('live: prints the checklist after materialization', () => {
    const { claudeHome, repoHome } = makeTempRoots();
    makeLinkedFile(claudeHome, repoHome, 'CLAUDE.md');

    cmdEject({}, { claudeHome, repoHome });

    const out = allLogs(logSpy);
    expect(out).toContain('npm uninstall -g claude-nomad');
    expect(out).toContain('NOMAD_HOST');
  });

  it('repo-untouched: repoHome/shared files are not mutated after live eject', () => {
    const { claudeHome, repoHome } = makeTempRoots();
    makeLinkedFile(claudeHome, repoHome, 'CLAUDE.md', 'original');
    makeLinkedDir(claudeHome, repoHome, 'skills');

    const before = snapshotDir(join(repoHome, 'shared'));
    cmdEject({}, { claudeHome, repoHome });
    const after = snapshotDir(join(repoHome, 'shared'));

    for (const [name, mtime] of before) {
      expect(after.get(name)).toBe(mtime);
    }
  });

  it('checklist EJECT_CHECKLIST export contains npm uninstall and NOMAD_HOST items', () => {
    expect(EJECT_CHECKLIST).toContain('npm uninstall -g claude-nomad');
    expect(EJECT_CHECKLIST).toContain('NOMAD_HOST');
    expect(EJECT_CHECKLIST).toContain('NOMAD_REPO');
  });

  it('sharedDirs extra: a sharedDirs entry is materialized like a built-in name', () => {
    const { claudeHome, repoHome } = makeTempRoots();
    writeFileSync(
      join(repoHome, 'path-map.json'),
      JSON.stringify({ projects: {}, sharedDirs: ['get-shit-done'] }),
    );
    const gsdTarget = join(repoHome, 'shared', 'get-shit-done');
    mkdirSync(gsdTarget, { recursive: true });
    writeFileSync(join(gsdTarget, 'README.md'), '# GSD');
    symlinkSync(gsdTarget, join(claudeHome, 'get-shit-done'));

    cmdEject({}, { claudeHome, repoHome });

    const ejected = join(claudeHome, 'get-shit-done');
    expect(lstatSync(ejected).isSymbolicLink()).toBe(false);
    expect(lstatSync(ejected).isDirectory()).toBe(true);
    expect(readFileSync(join(ejected, 'README.md'), 'utf8')).toBe('# GSD');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ejected: get-shit-done'));
  });
});
