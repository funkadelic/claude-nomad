import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { enforceAllowList } from './commands.ts';
import { type PathMap } from './config.ts';

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
    const status = ' M shared/CLAUDE.md\n M hosts/test-host.json\n M path-map.json\n';
    const map: PathMap = { projects: {} };
    enforceAllowList(status, map);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects unknown path with FATAL message and exits 1', () => {
    const status = ' M random/secret.key\n';
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow('exit:1');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('to sync random/secret.key, add to PUSH_ALLOWED in src/config.ts'),
    );
  });

  it('rejects NEVER_SYNC path with FATAL message and exits 1', () => {
    const status = '?? .claude.json\n';
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow('exit:1');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('.claude.json is in NEVER_SYNC and must never be pushed'),
    );
  });

  it('allows data-driven shared/projects/<logical>/ when logical is in path-map', () => {
    const status = ' M shared/projects/ha-acwd/session-123.jsonl\n';
    const map: PathMap = {
      projects: { 'ha-acwd': { 'test-host': '/home/test/ha-acwd' } },
    };
    enforceAllowList(status, map);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('anchored prefix prevents shared/agents-x/ matching shared/agents/', () => {
    const status = ' M shared/agents-x/leaked.token\n';
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow('exit:1');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'to sync shared/agents-x/leaked.token, add to PUSH_ALLOWED in src/config.ts',
      ),
    );
  });

  it('enumerates multiple violations in a single output before exit', () => {
    const status = '?? .claude.json\n M random/foo.bar\n';
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow('exit:1');
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('.claude.json is in NEVER_SYNC and must never be pushed'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('to sync random/foo.bar, add to PUSH_ALLOWED in src/config.ts'),
    );
  });
});
