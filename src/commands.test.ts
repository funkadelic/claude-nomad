import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { enforceAllowList } from './commands.ts';
import { type PathMap } from './config.ts';
import { NomadFatal } from './utils.ts';

// CR-02: parsePorcelainZ tests cover the format switch from `--porcelain` (LF,
// quoted, "old -> new" rename strings) to `--porcelain=v1 -z` (NUL records,
// no quoting, rename = two records "R  new\0old\0").
// Helper: build a NUL-delimited porcelain stream from rows. Use `null` as a
// row to inject a trailing NUL pair (e.g. for rename's old-path field).
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

  // CR-02 regression: porcelain rename rows in -z mode emit "R  new\0old\0",
  // NOT the LF-mode "R  old -> new". Both halves should classify against the
  // allow-list (so legitimate `git mv shared/CLAUDE.md shared/CLAUDE2.md`
  // passes because both halves match `shared/CLAUDE.md` / via shared/ prefix).
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
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('to sync random/secret.key'),
    );
  });

  // CR-02 regression: in -z mode quoted paths are NOT used; filenames with
  // spaces remain literal. Pre-fix the parser used slice(3).trim() on LF
  // output which left literal double-quotes in the path. After fix, the
  // shared/agents/ prefix correctly matches the literal-space filename.
  it('matches literal filename containing spaces against shared/agents/ prefix', () => {
    const status = z(['?? shared/agents/My Agent.md']);
    const map: PathMap = { projects: {} };
    enforceAllowList(status, map);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // WR-01: hosts/ allow-list entry must NOT accept arbitrary filenames.
  it('rejects hosts/secret.key (extension other than .json under hosts/)', () => {
    const status = z(['?? hosts/secret.key']);
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('to sync hosts/secret.key'),
    );
  });

  it('rejects hosts/.env.production (no .json extension)', () => {
    const status = z(['?? hosts/.env.production']);
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('to sync hosts/.env.production'),
    );
  });

  it('rejects hosts/sub/nested.json (nested depth beyond one level)', () => {
    const status = z(['?? hosts/sub/nested.json']);
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('to sync hosts/sub/nested.json'),
    );
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
