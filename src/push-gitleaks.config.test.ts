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
    const { resolveTomlPath } = await import('./push-gitleaks.config.ts');
    const result = resolveTomlConfig();
    expect(result.path).toBe(resolveTomlPath());
    expect(result.path).toBe(join(repoHome, '.gitleaks.toml'));
    expect(result.tempPath).toBeNull();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('generates a temp config in a private dir extending the absolute bundled path (mode 0o600, wx)', async () => {
    // Overlay present, no full repo toml. resolveTomlPath falls through to the
    // bundled copy (existsSync first call false -> repo toml absent, second true
    // -> bundled present). The overlay existsSync (third call) must be true.
    // mkdtempSync is mocked to a deterministic private dir; the config file is
    // written inside it (CWE-377 hardening: private dir + exclusive `wx` flag).
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
        readFileSync: vi.fn(() => '[[allowlists]]\nregexes = ["MY_TOKEN"]\npaths = ["x.txt"]\n'),
        mkdtempSync: vi.fn((prefix: unknown) => `${String(prefix)}AbCdEf`),
        writeFileSync: vi.fn((p: unknown, body: unknown, opts: unknown) => {
          writtenPath = String(p);
          writtenBody = String(body);
          writtenOpts = opts;
        }),
      };
    });
    const { resolveTomlConfig } = await import('./push-gitleaks.config.ts');
    const { resolveTomlPath } = await import('./push-gitleaks.config.ts');
    const bundled = resolveTomlPath()!;
    const result = resolveTomlConfig();
    // tempPath is the private temp DIRECTORY; path is the config file inside it.
    expect(result.tempPath).not.toBeNull();
    expect(result.tempPath).toContain('nomad-gitleaks-cfg');
    expect(result.path).toBe(join(result.tempPath!, 'config.toml'));
    expect(writtenPath).toBe(result.path);
    // Body extends the absolute bundled path via JSON.stringify and includes the overlay body.
    expect(writtenBody).toMatch(/^\[extend\]\npath = "/);
    expect(writtenBody).toContain(`path = ${JSON.stringify(bundled)}`);
    expect(writtenBody.startsWith('/')).toBe(false); // sanity: starts with [extend]
    expect(writtenBody).toContain('MY_TOKEN');
    expect(writtenOpts).toEqual({ mode: 0o600, flag: 'wx' });
  });

  it.each([
    ['inner whitespace header', '[ extend ]\npath = "/evil"\n'],
    ['trailing-bracket whitespace', '[extend ]\nuseDefault = true\n'],
    ['leading-bracket whitespace', '[ extend]\nuseDefault = true\n'],
    ['dotted key', 'extend.path = "/evil"\n[[allowlists]]\nregexes = ["X"]\n'],
    ['inline table', 'extend = { path = "/evil" }\n'],
  ])(
    'CR-01: rejects a TOML-equivalent [extend] bypass (%s) with NomadFatal and no temp write',
    async (_label, overlayBody) => {
      // The D-05 guard must catch every TOML form that loads the `extend` table,
      // not just the exact `[extend]` literal, or the depth-3 silent-drop reopens.
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
          readFileSync: vi.fn(() => overlayBody),
          writeFileSync: writeSpy,
        };
      });
      const { resolveTomlConfig } = await import('./push-gitleaks.config.ts');
      const { NomadFatal } = await import('./utils.ts');
      expect(() => resolveTomlConfig()).toThrow(NomadFatal);
      expect(writeSpy).not.toHaveBeenCalled();
    },
  );

  it('CR-01: does NOT false-positive on keys merely starting with "extend"', async () => {
    // A clean overlay whose allowlist describes "extended" coverage must still
    // generate a temp config (the guard targets the `extend` table, not the word).
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
        readFileSync: vi.fn(
          () =>
            '[[allowlists]]\ndescription = "extended coverage"\nregexes = ["X"]\npaths = ["x.txt"]\n',
        ),
        mkdtempSync: vi.fn((prefix: unknown) => `${String(prefix)}GhIjKl`),
        writeFileSync: vi.fn(),
      };
    });
    const { resolveTomlConfig } = await import('./push-gitleaks.config.ts');
    const result = resolveTomlConfig();
    expect(result.tempPath).not.toBeNull();
    expect(result.path).toBe(join(result.tempPath!, 'config.toml'));
  });

  it.each([
    ['allowlist with no paths scope', '[[allowlists]]\nregexes = ["X"]\n'],
    [
      'second block drops paths',
      '[[allowlists]]\npaths = ["a.txt"]\n[[allowlists]]\nregexes = ["X"]\n',
    ],
    ['catch-all regex', "[[allowlists]]\nregexes = ['''.*''']\npaths = [\"a.txt\"]\n"],
    ['catch-all path', '[[allowlists]]\npaths = ["^.*$"]\n'],
    ['comment before unscoped block', '# my overlay\n[[allowlists]]\nregexes = ["X"]\n'],
  ])(
    'rejects an unscoped overlay allowlist (%s) with NomadFatal and no temp write',
    async (_label, overlayBody) => {
      // An overlay allowlist that is not path-scoped (no `paths`) or uses a
      // catch-all pattern would suppress findings repo-wide and, because the
      // overlay syncs across hosts, disable scanning fleet-wide. It must fail
      // LOUD before any temp config is generated.
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
          readFileSync: vi.fn(() => overlayBody),
          writeFileSync: writeSpy,
        };
      });
      const { resolveTomlConfig } = await import('./push-gitleaks.config.ts');
      const { NomadFatal } = await import('./utils.ts');
      expect(() => resolveTomlConfig()).toThrow(NomadFatal);
      expect(writeSpy).not.toHaveBeenCalled();
    },
  );

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
    writeFileSync(
      join(repoHome, '.gitleaks.overlay.toml'),
      '[[allowlists]]\nregexes = ["X"]\npaths = ["x.txt"]\n',
    );
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
        readFileSync: vi.fn(() => '[[allowlists]]\nregexes = ["MY_TOKEN"]\npaths = ["x.txt"]\n'),
        writeFileSync: vi.fn(() => {
          const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
          err.code = 'ENOSPC';
          throw err;
        }),
      };
    });
    const { resolveTomlConfig } = await import('./push-gitleaks.config.ts');
    const { resolveTomlPath } = await import('./push-gitleaks.config.ts');
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

/**
 * Unit tests for `resolveTomlPath`: the three-branch two-tier lookup (repo
 * copy present, repo absent + bundled present, both absent). Uses existsSync
 * mocking to control filesystem outcomes independently of the dev environment.
 */
describe('resolveTomlPath (two-tier toml lookup)', () => {
  let originalNomadRepo: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:fs');
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
  });

  it('returns the REPO_HOME path when the repo copy exists', async () => {
    process.env.NOMAD_REPO = '/fake/repo';
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        existsSync: vi.fn((p: unknown) => String(p).endsWith('.gitleaks.toml')),
      };
    });
    const { resolveTomlPath } = await import('./push-gitleaks.config.ts');
    expect(resolveTomlPath()).toBe('/fake/repo/.gitleaks.toml');
  });

  it('returns the bundled path when repo copy is absent but bundled exists', async () => {
    process.env.NOMAD_REPO = '/fake/repo';
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        // First call (REPO_HOME toml) -> false, second call (bundled) -> true.
        existsSync: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
      };
    });
    const { resolveTomlPath } = await import('./push-gitleaks.config.ts');
    const result = resolveTomlPath();
    expect(result).not.toBeNull();
    expect(result).toMatch(/\.gitleaks\.toml$/);
    // Must NOT be the repo copy.
    expect(result).not.toBe('/fake/repo/.gitleaks.toml');
  });

  it('returns null when neither repo copy nor bundled copy exists', async () => {
    process.env.NOMAD_REPO = '/fake/repo';
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
    });
    const { resolveTomlPath } = await import('./push-gitleaks.config.ts');
    expect(resolveTomlPath()).toBeNull();
  });
});
