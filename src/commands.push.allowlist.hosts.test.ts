/**
 * Regression suite for the `hosts/` allow-list JSON-only guard in
 * `enforceAllowList` (src/commands.push.allowlist.ts). Closes issue #138
 * as verified-safe: the `continue` after `^hosts\/[^/]+\.json$` already
 * blocks non-.json extensions and nested paths; no production code change
 * is required. These tests pin that invariant so a future edit that drops
 * the `continue` or loosens the regex will fail CI.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { PathMap } from './config.ts';

describe('enforceAllowList: hosts/ JSON-only guard (issue #138)', () => {
  let errorSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows hosts/<name>.json (the legitimate single-level JSON case)', async () => {
    // `hosts/dell-wsl.json` matches the `^hosts\/[^/]+\.json$` special case
    // exactly. `enforceAllowList` must not throw; no FATAL is logged.
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('?? hosts/dell-wsl.json\0', map)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects hosts/<name>.key as a credential file (NEVER_SYNC)', async () => {
    // A private key file with the `hosts/` prefix must be blocked. The
    // credential-file pattern (`.key`) classifies it as NEVER_SYNC, a stronger
    // hard-block than the plain allow-list violation, so it is rejected before
    // the `hosts/` JSON-only guard is even reached.
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('?? hosts/dell-wsl.key\0', map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('hosts/dell-wsl.key is in NEVER_SYNC'),
    );
  });

  it('rejects hosts/<name>.txt (non-.json, non-credential extension under hosts/)', async () => {
    // A non-credential, non-`.json` file under `hosts/` exercises the
    // `isAllowed` hosts/ guard directly: the `^hosts\/[^/]+\.json$` special case
    // does not match, the `continue` prevents the prefix fallthrough, and it
    // surfaces as a plain allow-list violation (not NEVER_SYNC).
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('?? hosts/dell-wsl.txt\0', map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('to sync hosts/dell-wsl.txt'));
  });

  it('rejects nested hosts/sub/x.json (multi-level path under hosts/)', async () => {
    // `hosts/sub/x.json` contains a `/` in the name component, so
    // `^hosts\/[^/]+\.json$` does not match (`[^/]+` forbids slashes).
    // The `continue` prevents the prefix fallthrough; the path must be
    // rejected regardless of the `.json` extension.
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('?? hosts/sub/x.json\0', map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('to sync hosts/sub/x.json'));
  });

  it('allows bare hosts/ (exact-match of the allow-list entry itself)', async () => {
    // A bare `hosts/` record (e.g. a git-collapsed untracked directory) matches
    // `path === entry` in `isAllowed` BEFORE the `hosts/` special-case regex
    // runs. The exact-match short-circuits and admits it. This is existing
    // behavior: the `hosts/` entry is an exact static member of
    // `PUSH_ALLOWED_STATIC`, so staging the directory itself is allowed. The
    // security-relevant threat (credential files like `hosts/dell-wsl.key`)
    // is handled by the regex guard on the CONTENT records, not the directory
    // record. Documented here so a future refactor does not incorrectly
    // tighten this case and break pushes on a fresh host whose `hosts/`
    // directory is entirely untracked.
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('?? hosts/\0', map)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
