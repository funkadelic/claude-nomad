import type * as cpModule from 'node:child_process';
import type * as fsModule from 'node:fs';

import { vi } from 'vitest';

/**
 * True when `arg` parses as a URL whose host is exactly `registry.npmjs.org`.
 * Used by the curl mock to identify the npm registry call without a substring
 * check on the URL (which CodeQL flags as
 * `js/incomplete-url-substring-sanitization`).
 *
 * @param arg The candidate URL string.
 * @returns Whether the host is `registry.npmjs.org`.
 */
export function isNpmRegistryUrl(arg: string): boolean {
  try {
    return new URL(arg).hostname === 'registry.npmjs.org';
  } catch {
    return false;
  }
}

/**
 * Mock the local `package.json` read inside `commands.doctor.version.ts`.
 * Production code resolves the path via `new URL('../package.json',
 * import.meta.url).pathname`, which lands at the REAL repo root regardless
 * of `$HOME`. We override `node:fs.readFileSync` to intercept any path that
 * ends in `/package.json` and substitute the test version; all other reads
 * (sandbox HOME, settings files, gitleaks probes, etc.) fall through to the
 * real implementation so the rest of `cmdDoctor` behaves normally.
 *
 * @param version The version to report, or null to throw ENOENT.
 * @param engines Optional `engines` field to attach to the faked package.json.
 */
export function mockPackageJsonVersion(
  version: string | null,
  engines?: { node?: string } | null,
): void {
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof fsModule>();
    return {
      ...actual,
      readFileSync: vi.fn(
        (path: fsModule.PathOrFileDescriptor, opts?: Parameters<typeof actual.readFileSync>[1]) => {
          if (typeof path === 'string' && path.endsWith('/package.json')) {
            if (version === null) {
              const err = new Error('ENOENT package.json') as NodeJS.ErrnoException;
              err.code = 'ENOENT';
              throw err;
            }
            const pkg: Record<string, unknown> = { name: 'claude-nomad', version };
            if (engines !== undefined && engines !== null) pkg.engines = engines;
            return JSON.stringify(pkg);
          }
          return actual.readFileSync(path, opts);
        },
      ),
    };
  });
}

/**
 * Mock `node:child_process` so the curl call to the npm registry returns a
 * deterministic response. Behaviors:
 *   - `{ kind: 'json', version }`: return a buffer of `{"version":"<ver>"}`
 *   - `{ kind: 'no_version' }`: return a JSON payload with no `version` field,
 *     so `fetchLatestVersion` parses cleanly but finds no version and falls
 *     through to the silent-skip path.
 *   - `{ kind: 'garbage' }`: return a non-JSON buffer (forces parse failure)
 *   - `{ kind: 'throw' }`: throw with the given error code (default ENOENT
 *     so the offline-skip path looks like curl-missing).
 * The gitleaks probe is always answered with a fake version so it does not
 * pollute `process.exitCode` on dev hosts that lack the binary.
 *
 * @param response The deterministic curl behavior to simulate.
 */
export function mockCurlReleases(
  response:
    | { kind: 'json'; version: string }
    | { kind: 'no_version' }
    | { kind: 'garbage' }
    | { kind: 'throw'; code?: string },
): void {
  vi.doMock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof cpModule>();
    return {
      ...actual,
      execFileSync: vi.fn(
        (
          bin: string,
          args: readonly string[],
          opts?: Parameters<typeof cpModule.execFileSync>[2],
        ) => {
          if (bin === 'curl' && args.some(isNpmRegistryUrl)) {
            if (response.kind === 'throw') {
              const err = new Error(
                `curl mocked: ${response.code ?? 'ENOENT'}`,
              ) as NodeJS.ErrnoException;
              err.code = response.code ?? 'ENOENT';
              throw err;
            }
            if (response.kind === 'garbage') {
              return Buffer.from('not-json-at-all');
            }
            if (response.kind === 'no_version') {
              return Buffer.from(JSON.stringify({ name: 'claude-nomad' }));
            }
            return Buffer.from(JSON.stringify({ version: response.version }));
          }
          if (bin === 'gitleaks' && args[0] === 'version') {
            return Buffer.from('v8.18.2\n');
          }
          return actual.execFileSync(bin, args, opts);
        },
      ),
    };
  });
}

/**
 * Override `process.version` for a single test. The caller is responsible for
 * capturing the pre-override value in `beforeEach` and restoring it in
 * `afterEach`; this helper is fire-and-forget. `process.version` is a getter
 * on the Node global, so `Object.defineProperty` with `configurable: true` is
 * the supported way to swap it for testing.
 *
 * @param v The fake `process.version` string to install.
 */
export function setNodeVersion(v: string): void {
  Object.defineProperty(process, 'version', { value: v, configurable: true });
}
