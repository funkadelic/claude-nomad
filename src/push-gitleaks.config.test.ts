import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type * as fsModule from 'node:fs';

/**
 * Unit coverage for `resolveTomlConfig`: the overlay base+overlay merge that
 * layers `REPO_HOME/.gitleaks.overlay.toml` on the package-bundled
 * `.gitleaks.toml`. Covers all six branches: no overlay (delegates), S-01
 * precedence (full repo toml wins + warn), bundled-absent fallback, the D-05
 * `[extend]` NomadFatal, successful temp generation, and the D-04
 * temp-write-failure fallback. Uses a real tmpdir HOME so REPO_HOME resolves to
 * a writable path, and `vi.doMock('node:fs')` for the branches that need
 * synthesized existsSync / writeFileSync outcomes.
 */
describe('resolveTomlConfig (overlay merge logic)', () => {
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let repoHome: string;
  let warnSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-toml-config-'));
    process.env.HOME = testHome;
    repoHome = join(testHome, 'repo');
    process.env.NOMAD_REPO = repoHome;
    mkdirSync(repoHome, { recursive: true });
    vi.resetModules();
    warnSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:fs');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('delegates to resolveTomlPath when no overlay is present (no temp written)', async () => {
    // No overlay file; a REPO_HOME/.gitleaks.toml exists so resolveTomlPath
    // returns it. tempPath must be null and no writeFileSync must fire.
    writeFileSync(join(repoHome, '.gitleaks.toml'), '[extend]\nuseDefault = true\n');
    const writeSpy = vi.fn();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, writeFileSync: vi.fn(actual.writeFileSync).mockImplementation(writeSpy) };
    });
    const { resolveTomlConfig } = await import('./push-gitleaks.config.ts');
    const { resolveTomlPath } = await import('./push-gitleaks.scan.ts');
    const result = resolveTomlConfig();
    expect(result.path).toBe(resolveTomlPath());
    expect(result.path).toBe(join(repoHome, '.gitleaks.toml'));
    expect(result.tempPath).toBeNull();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('generates a temp config extending the absolute bundled path with mode 0o600', async () => {
    // Overlay present, no full repo toml. resolveTomlPath falls through to the
    // bundled copy (existsSync first call false -> repo toml absent, second true
    // -> bundled present). The overlay existsSync (third call) must be true.
    let writtenPath = '';
    let writtenBody = '';
    let writtenOpts: unknown;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        // resolveTomlPath: repo toml absent, bundled present.
        // resolveTomlConfig overlay check: present.
        existsSync: vi.fn((p: unknown) => {
          const s = String(p);
          if (s === join(repoHome, '.gitleaks.toml')) return false; // repo toml absent
          if (s.endsWith('.gitleaks.overlay.toml')) return true; // overlay present
          return true; // bundled present
        }),
        readFileSync: vi.fn(() => '[[allowlists]]\nregexes = ["MY_TOKEN"]\n'),
        writeFileSync: vi.fn((p: unknown, body: unknown, opts: unknown) => {
          writtenPath = String(p);
          writtenBody = String(body);
          writtenOpts = opts;
        }),
      };
    });
    const { resolveTomlConfig } = await import('./push-gitleaks.config.ts');
    const { resolveTomlPath } = await import('./push-gitleaks.scan.ts');
    const bundled = resolveTomlPath()!;
    const result = resolveTomlConfig();
    expect(result.tempPath).not.toBeNull();
    expect(result.path).toBe(result.tempPath);
    expect(result.tempPath).toContain('nomad-gitleaks-cfg');
    expect(writtenPath).toBe(result.tempPath);
    // Body extends the absolute bundled path via JSON.stringify and includes the overlay body.
    expect(writtenBody).toMatch(/^\[extend\]\npath = "/);
    expect(writtenBody).toContain(`path = ${JSON.stringify(bundled)}`);
    expect(writtenBody.startsWith('/')).toBe(false); // sanity: starts with [extend]
    expect(writtenBody).toContain('MY_TOKEN');
    expect(writtenOpts).toEqual({ mode: 0o600 });
  });

  it('throws NomadFatal and writes no temp when the overlay contains its own [extend] (D-05)', async () => {
    const writeSpy = vi.fn();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        existsSync: vi.fn((p: unknown) => {
          const s = String(p);
          if (s === join(repoHome, '.gitleaks.toml')) return false; // repo toml absent
          if (s.endsWith('.gitleaks.overlay.toml')) return true; // overlay present
          return true; // bundled present
        }),
        readFileSync: vi.fn(() => '[extend]\npath = "/evil"\n\n[[allowlists]]\nregexes = ["X"]\n'),
        writeFileSync: writeSpy,
      };
    });
    const { resolveTomlConfig } = await import('./push-gitleaks.config.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => resolveTomlConfig()).toThrow(NomadFatal);
    expect(() => resolveTomlConfig()).toThrow(/\[extend\] block/);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('S-01: a full REPO_HOME/.gitleaks.toml wins; overlay ignored with one warn, no temp', async () => {
    // Both the full repo toml and the overlay exist. resolveTomlPath returns the
    // repo toml; resolveTomlConfig must short-circuit, warn once, and write no temp.
    writeFileSync(join(repoHome, '.gitleaks.toml'), '[extend]\nuseDefault = true\n');
    writeFileSync(join(repoHome, '.gitleaks.overlay.toml'), '[[allowlists]]\nregexes = ["X"]\n');
    const writeSpy = vi.fn();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, writeFileSync: vi.fn(actual.writeFileSync).mockImplementation(writeSpy) };
    });
    const { resolveTomlConfig } = await import('./push-gitleaks.config.ts');
    const result = resolveTomlConfig();
    expect(result.path).toBe(join(repoHome, '.gitleaks.toml'));
    expect(result.tempPath).toBeNull();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('takes precedence'));
  });

  it('D-04: overlay present but bundled base absent -> path null, tempPath null, no throw', async () => {
    // Overlay present, but neither repo toml nor bundled copy resolvable.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        existsSync: vi.fn((p: unknown) => String(p).endsWith('.gitleaks.overlay.toml')),
      };
    });
    const { resolveTomlConfig } = await import('./push-gitleaks.config.ts');
    const result = resolveTomlConfig();
    expect(result.path).toBeNull();
    expect(result.tempPath).toBeNull();
  });

  it('D-04: temp-config writeFileSync failure falls back to the bundled base (warn, not thrown)', async () => {
    // Overlay present, bundled resolvable, a clean (no-[extend]) overlay body, but
    // writeFileSync throws (simulated ENOSPC). Must warn, return the BUNDLED path
    // (not null), tempPath null, and NOT throw NomadFatal.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        existsSync: vi.fn((p: unknown) => {
          const s = String(p);
          if (s === join(repoHome, '.gitleaks.toml')) return false; // repo toml absent
          if (s.endsWith('.gitleaks.overlay.toml')) return true; // overlay present
          return true; // bundled present
        }),
        readFileSync: vi.fn(() => '[[allowlists]]\nregexes = ["MY_TOKEN"]\n'),
        writeFileSync: vi.fn(() => {
          const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
          err.code = 'ENOSPC';
          throw err;
        }),
      };
    });
    const { resolveTomlConfig } = await import('./push-gitleaks.config.ts');
    const { resolveTomlPath } = await import('./push-gitleaks.scan.ts');
    const bundledPath = resolveTomlPath()!;
    const result = resolveTomlConfig();
    expect(result.path).toBe(bundledPath);
    expect(result.path).not.toBeNull();
    expect(result.tempPath).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('falling back to the bundled allowlist'),
    );
  });

  it('companion: the [extend] NomadFatal (D-05) is NOT suppressed by the D-04 write fallback', async () => {
    // Same routing as the write-failure case, but the overlay has its own
    // [extend]. The D-05 guard must fire BEFORE the try/catch, so NomadFatal is
    // thrown even though a writeFileSync failure would otherwise be swallowed.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        existsSync: vi.fn((p: unknown) => {
          const s = String(p);
          if (s === join(repoHome, '.gitleaks.toml')) return false;
          if (s.endsWith('.gitleaks.overlay.toml')) return true;
          return true;
        }),
        readFileSync: vi.fn(() => '  [extend]\nuseDefault = true\n'),
        writeFileSync: vi.fn(() => {
          throw new Error('should never be reached');
        }),
      };
    });
    const { resolveTomlConfig } = await import('./push-gitleaks.config.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => resolveTomlConfig()).toThrow(NomadFatal);
  });
});
