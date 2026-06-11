import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { enforceAllowList } from './commands.push.allowlist.ts';
import { type PathMap } from './config.ts';
import { NomadFatal } from './utils.ts';

// parsePorcelainZ tests cover the format switch from `--porcelain` (LF,
// quoted, "old -> new" rename strings) to `--porcelain=v1 -z` (NUL records,
// no quoting, rename = two records "R  new\0old\0").

/**
 * Build a NUL-delimited porcelain stream from rows. Each row is joined with
 * `\0` and a trailing `\0` terminator is appended (mirrors `git status -z`
 * output where every record ends in a NUL byte, including the last one).
 */
function z(rows: string[]): string {
  return rows.join('\0') + '\0';
}

describe('enforceAllowList', () => {
  let exitSpy: MockInstance<(code?: string | number | null) => never>;
  let errorSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${String(code)}`);
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      // Capture only; assertions inspect call list.
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows clean status with only allow-listed paths', () => {
    const status = z([' M shared/CLAUDE.md', ' M hosts/test-host.json', ' M path-map.json']);
    const map: PathMap = { projects: {} };
    enforceAllowList(status, map);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects unknown path with FATAL message and throws NomadFatal', () => {
    const status = z([' M random/secret.key']);
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('to sync random/secret.key, add to PUSH_ALLOWED in src/config.ts'),
    );
  });

  it('rejects NEVER_SYNC path with FATAL message and throws NomadFatal', () => {
    const status = z(['?? .claude.json']);
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('.claude.json is in NEVER_SYNC and must never be pushed'),
    );
  });

  it('allows data-driven shared/projects/<logical>/ when logical is in path-map', () => {
    const status = z([' M shared/projects/ha-acwd/session-123.jsonl']);
    const map: PathMap = {
      projects: { 'ha-acwd': { 'test-host': '/home/test/ha-acwd' } },
    };
    enforceAllowList(status, map);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('anchored prefix prevents shared/agents-x/ matching shared/agents/', () => {
    const status = z([' M shared/agents-x/leaked.token']);
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'to sync shared/agents-x/leaked.token, add to PUSH_ALLOWED in src/config.ts',
      ),
    );
  });

  it('enumerates multiple violations in a single output before throwing', () => {
    const status = z(['?? .claude.json', ' M random/foo.bar']);
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('.claude.json is in NEVER_SYNC and must never be pushed'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('to sync random/foo.bar, add to PUSH_ALLOWED in src/config.ts'),
    );
  });

  // Porcelain rename rows in -z mode emit "R  new\0old\0", NOT the LF-mode
  // "R  old -> new". Both halves should classify against the allow-list
  // (so legitimate `git mv shared/CLAUDE.md shared/CLAUDE2.md` passes
  // because both halves match `shared/CLAUDE.md` via the shared/ prefix).
  it('classifies both halves of a rename row independently and allows clean git mv', () => {
    // Rename within allow-list: status "R  shared/CLAUDE.md\0shared/CLAUDE.md\0"
    // (new + old both shared/CLAUDE.md exact match; in real usage they would
    // differ but still both match an allow-listed entry).
    const status = z(['R  shared/CLAUDE.md', 'shared/CLAUDE.md']);
    const map: PathMap = { projects: {} };
    enforceAllowList(status, map);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('flags rename whose source half escapes the allow-list', () => {
    // git mv random/secret.key shared/agents/secret.key would surface in -z
    // porcelain as "R  shared/agents/secret.key\0random/secret.key\0". The new
    // half is allowed (shared/agents/ prefix), but the OLD half is not, so
    // enforceAllowList must reject.
    const status = z(['R  shared/agents/secret.key', 'random/secret.key']);
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('to sync random/secret.key'));
  });

  it('flags rename detected in the Y column (working-tree rename, X is space)', () => {
    // Y-column rename row format: ` R shared/agents/x\0random/y\0`. Earlier
    // detection only checked X (xy.startsWith('R')) and would have parsed the
    // OLD path record as a new entry on the next iteration, misclassifying
    // random/y and potentially smuggling unallowed sources past the
    // allow-list. parsePorcelainZ now checks both XY positions.
    const status = z([' R shared/agents/new.md', 'random/escaped.md']);
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('to sync random/escaped.md'));
  });

  it('flags copy detected in the Y column (working-tree copy, X is space)', () => {
    // Y-column copy row format: ` C shared/agents/copy.md\0random/source.md\0`.
    // Same defense as Y-column R, but for `C` (copy) records.
    const status = z([' C shared/agents/copy.md', 'random/source.md']);
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('to sync random/source.md'));
  });

  // In -z mode quoted paths are NOT used; filenames with spaces remain
  // literal. Earlier code used slice(3).trim() on LF output, which left
  // literal double-quotes in the path. The current parser keeps spaces
  // literal so the shared/skills/ prefix matches the filename directly.
  it('matches literal filename containing spaces against shared/skills/ prefix', () => {
    // shared/agents/ was removed from PUSH_ALLOWED_STATIC (gsd-owned); use shared/skills/ instead.
    const status = z(['?? shared/skills/My Skill.md']);
    const map: PathMap = { projects: {} };
    enforceAllowList(status, map);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // hosts/ allow-list entry must NOT accept arbitrary filenames.
  it('rejects hosts/secret.key (extension other than .json under hosts/)', () => {
    const status = z(['?? hosts/secret.key']);
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('to sync hosts/secret.key'));
  });

  it('rejects hosts/.env.production (no .json extension)', () => {
    const status = z(['?? hosts/.env.production']);
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('to sync hosts/.env.production'));
  });

  it('rejects hosts/sub/nested.json (nested depth beyond one level)', () => {
    const status = z(['?? hosts/sub/nested.json']);
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('to sync hosts/sub/nested.json'));
  });

  it('allows hosts/dell-wsl.json (single-level .json file under hosts/)', () => {
    const status = z([' M hosts/dell-wsl.json']);
    const map: PathMap = { projects: {} };
    enforceAllowList(status, map);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('flags unknown path with spaces using the literal filename in the error', () => {
    // Filename contains spaces and lands outside the allow-list. The pre-fix
    // LF parser would have emitted "\"random dir/foo bar.token\"" (with
    // literal quotes from git's core.quotepath). The -z parser preserves the
    // literal path so the error message is correct and grep-friendly.
    const status = z(['?? random dir/foo bar.token']);
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('to sync random dir/foo bar.token'),
    );
  });
});
