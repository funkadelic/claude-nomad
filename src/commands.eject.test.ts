import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { cmdEject, ejectChecklist, errMessage, previewMaterialize } from './commands.eject.ts';

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

  it('default roots: bare cmdEject resolves claudeHome/repoHome from the env at call time', () => {
    const originalHome = process.env.HOME;
    const originalNomadRepo = process.env.NOMAD_REPO;
    // Build a HOME/.claude + NOMAD_REPO pair so the parameter default
    // (defaultEjectRoots) resolves to these temp roots.
    const base = mkdtempSync(join(tmpdir(), 'nomad-eject-defaults-'));
    const home = join(base, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const repo = join(base, 'repo');
    mkdirSync(join(repo, 'shared'), { recursive: true });
    makeLinkedFile(join(home, '.claude'), repo, 'CLAUDE.md', 'via defaults');
    process.env.HOME = home;
    process.env.NOMAD_REPO = repo;
    try {
      cmdEject({ dryRun: true });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('would materialize: CLAUDE.md'));
      // dry-run: the symlink is untouched.
      expect(lstatSync(join(home, '.claude', 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    } finally {
      process.env.HOME = originalHome;
      if (originalNomadRepo === undefined) delete process.env.NOMAD_REPO;
      else process.env.NOMAD_REPO = originalNomadRepo;
      rmSync(base, { recursive: true, force: true });
    }
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
    // skills is no longer in SHARED_LINKS (copy-synced); use commands instead.
    const { claudeHome, repoHome } = makeTempRoots();
    const { nestedFile } = makeLinkedDir(claudeHome, repoHome, 'commands');

    cmdEject({}, { claudeHome, repoHome });

    const linkPath = join(claudeHome, 'commands');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(lstatSync(linkPath).isDirectory()).toBe(true);
    const nestedContents = readFileSync(join(claudeHome, 'commands', 'nested.md'), 'utf8');
    expect(nestedContents).toBe('# commands');
    expect(readFileSync(nestedFile, 'utf8')).toBe('# commands');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ejected: commands'));
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
    makeLinkedDir(claudeHome, repoHome, 'commands');

    const before = snapshotDir(join(repoHome, 'shared'));
    cmdEject({}, { claudeHome, repoHome });
    const after = snapshotDir(join(repoHome, 'shared'));

    for (const [name, mtime] of before) {
      expect(after.get(name)).toBe(mtime);
    }
  });

  it('ejectChecklist() export contains npm uninstall and NOMAD_HOST items', () => {
    expect(ejectChecklist()).toContain('npm uninstall -g claude-nomad');
    expect(ejectChecklist()).toContain('NOMAD_HOST');
    expect(ejectChecklist()).toContain('NOMAD_REPO');
  });

  it('tally: live run logs a materialized/skipped summary before the checklist', () => {
    const { claudeHome, repoHome } = makeTempRoots();
    makeLinkedFile(claudeHome, repoHome, 'CLAUDE.md', 'one');
    writeFileSync(join(claudeHome, 'my-statusline.cjs'), 'real'); // skip-real

    cmdEject({}, { claudeHome, repoHome });

    const out = allLogs(logSpy);
    expect(out).toContain('materialized 1, skipped');
    // Tally precedes the checklist.
    expect(out.indexOf('materialized 1, skipped')).toBeLessThan(
      out.indexOf('npm uninstall -g claude-nomad'),
    );
  });

  it('unmanaged target: symlink pointing outside shared/ is left untouched and reported', () => {
    const { claudeHome, repoHome } = makeTempRoots();
    // Real target OUTSIDE repoHome/shared/.
    const outside = join(repoHome, 'elsewhere.md');
    writeFileSync(outside, 'not ours');
    symlinkSync(outside, join(claudeHome, 'CLAUDE.md'));

    cmdEject({}, { claudeHome, repoHome });

    const linkPath = join(claudeHome, 'CLAUDE.md');
    // Still a symlink; nothing was materialized.
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('skipped (not a nomad-managed target): CLAUDE.md'),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('materialized 0, skipped'));
  });

  it('unmanaged target dry-run: outside-shared symlink prints the skip line, not would-materialize', () => {
    const { claudeHome, repoHome } = makeTempRoots();
    const outside = join(repoHome, 'elsewhere.md');
    writeFileSync(outside, 'not ours');
    symlinkSync(outside, join(claudeHome, 'CLAUDE.md'));

    cmdEject({ dryRun: true }, { claudeHome, repoHome });

    const out = allLogs(logSpy);
    expect(out).toContain('skipped (not a nomad-managed target): CLAUDE.md');
    expect(out).not.toContain('would materialize: CLAUDE.md');
  });

  it('shared/ missing: FATAL with a nomad pull hint', () => {
    const { claudeHome, repoHome } = makeTempRoots();
    makeLinkedFile(claudeHome, repoHome, 'CLAUDE.md', 'x');
    // Remove shared/ AFTER the symlink resolves through it for classify... but
    // classify resolves through shared, so to keep the link non-dangling we
    // point CLAUDE.md at a target outside shared, then delete shared so its
    // realpath fails. Simpler: delete shared and point the link elsewhere.
    rmSync(join(claudeHome, 'CLAUDE.md'));
    rmSync(join(repoHome, 'shared'), { recursive: true, force: true });
    const elsewhere = join(repoHome, 'real.md');
    writeFileSync(elsewhere, 'x');
    symlinkSync(elsewhere, join(claudeHome, 'CLAUDE.md'));

    expect(() => cmdEject({}, { claudeHome, repoHome })).toThrow(
      /cannot resolve.*shared.*repo checkout incomplete/,
    );
  });

  it('live fs fault: read-only claudeHome aborts with a FATAL naming the failed entry', () => {
    const { claudeHome, repoHome } = makeTempRoots();
    makeLinkedFile(claudeHome, repoHome, 'CLAUDE.md', 'one');
    // Make claudeHome read-only so the sibling temp copy (cpSync) fails EACCES.
    chmodSync(claudeHome, 0o500);
    try {
      expect(() => cmdEject({}, { claudeHome, repoHome })).toThrow('process.exit(1)');
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to materialize CLAUDE.md'),
      );
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('already materialized: (none)'));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('do NOT delete'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      chmodSync(claudeHome, 0o700);
    }
  });

  it('live fs fault: reports already-materialized names completed before the failure', () => {
    const { claudeHome, repoHome } = makeTempRoots();
    // Use sharedDirs to control ordering: allSharedLinks puts SHARED_LINKS
    // first; CLAUDE.md materializes, then a later name fails. Point a later
    // managed name at a target we make unreadable so cpSync dereference fails.
    // skills is no longer in SHARED_LINKS (copy-synced); use commands instead.
    const okTarget = join(repoHome, 'shared', 'CLAUDE.md');
    writeFileSync(okTarget, 'ok');
    symlinkSync(okTarget, join(claudeHome, 'CLAUDE.md'));
    const badTarget = join(repoHome, 'shared', 'commands');
    mkdirSync(badTarget, { recursive: true });
    const badNested = join(badTarget, 'secret.md');
    writeFileSync(badNested, 'x');
    symlinkSync(badTarget, join(claudeHome, 'commands'));
    chmodSync(badNested, 0o000); // unreadable; dereference copy fails

    try {
      expect(() => cmdEject({}, { claudeHome, repoHome })).toThrow('process.exit(1)');
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to materialize commands'),
      );
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('already materialized: CLAUDE.md'),
      );
    } finally {
      chmodSync(badNested, 0o600);
    }
  });

  it('errMessage: extracts .message from Error and String-coerces non-Error throws', () => {
    expect(errMessage(new Error('boom'))).toBe('boom');
    expect(errMessage('plain string')).toBe('plain string');
    expect(errMessage(42)).toBe('42');
  });

  it('previewMaterialize unresolvable: missing linkPath degrades to a re-classify hint (WR-03 TOCTOU)', () => {
    const { repoHome } = makeTempRoots();
    const sharedRoot = join(repoHome, 'shared');
    // linkPath does not exist -> realpathSync throws -> degraded message.
    previewMaterialize('CLAUDE.md', join(repoHome, 'gone', 'CLAUDE.md'), sharedRoot);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('would materialize: CLAUDE.md (target now unresolvable'),
    );
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
