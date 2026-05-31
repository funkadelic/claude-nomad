import type * as cpModule from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { failGlyph, infoGlyph, okGlyph, warnGlyph } from './color.ts';
import { type Env, makeDoctorEnv, restoreEnv } from './commands.doctor.checks.test-helpers.ts';

/**
 * Deterministic fetcher mock for the settings-schema fetch inside
 * `commands.doctor.check-schema.ts`. Intercepts both `curl` (primary) and
 * `wget` (fallback) so curl-throws cases never reach a real binary.
 * `json` returns a schema whose `properties` holds the given keys;
 * `no-properties` returns valid JSON lacking a properties object; `garbage`
 * returns non-JSON; `throw` simulates both binaries missing/offline.
 * All other execFileSync calls fall through.
 *
 * @param response The HTTP fetcher behavior to simulate.
 */
function mockCurlSchema(
  response:
    | { kind: 'json'; keys: string[] }
    | { kind: 'no-properties' }
    | { kind: 'garbage' }
    | { kind: 'throw' },
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
          // Intercept curl (primary) and wget (fallback) to keep the mock
          // deterministic regardless of which binary fetchUrl tries.
          if (bin === 'curl' || bin === 'wget') {
            if (response.kind === 'throw') throw new Error(`${bin} mocked offline`);
            if (bin === 'wget') {
              // wget is only reached if curl threw; in non-throw cases curl
              // returns first and wget is never invoked.
              throw new Error(`wget fallback unexpectedly reached in non-throw case`);
            }
            if (response.kind === 'garbage') return Buffer.from('not-json');
            if (response.kind === 'no-properties')
              return Buffer.from(JSON.stringify({ title: 'x' }));
            const properties = Object.fromEntries(response.keys.map((k) => [k, {}]));
            return Buffer.from(JSON.stringify({ properties }));
          }
          return actual.execFileSync(bin, args, opts);
        },
      ),
    };
  });
}

/** Build a Schema-scan section, run the reporter through a fresh module graph, and return its items joined. */
async function runCheckSchema(): Promise<string> {
  vi.resetModules();
  const { section } = await import('./commands.doctor.format.ts');
  const { reportCheckSchema } = await import('./commands.doctor.check-schema.ts');
  const sec = section('Schema scan');
  reportCheckSchema(sec);
  return sec.items.join('\n');
}

describe('nomad doctor --check-schema', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    env = makeDoctorEnv({ host: 'test-host' });
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  function writeSettings(obj: Record<string, unknown>): void {
    writeFileSync(join(env.testHome, '.claude', 'settings.json'), JSON.stringify(obj) + '\n');
  }

  it('emits an info line when there is no settings.json', async () => {
    const out = await runCheckSchema();
    expect(out).toContain(`${infoGlyph} no ~/.claude/settings.json to check`);
  });

  it('records a FAIL on malformed settings.json', async () => {
    writeFileSync(join(env.testHome, '.claude', 'settings.json'), '{ not json');
    const out = await runCheckSchema();
    expect(out).toContain(`${failGlyph}`);
    expect(out).toContain('malformed JSON');
  });

  it('skips with a WARN when the schema cannot be fetched (offline)', async () => {
    writeSettings({ model: 'sonnet' });
    mockCurlSchema({ kind: 'throw' });
    const out = await runCheckSchema();
    expect(out).toContain(`${warnGlyph} schema check skipped`);
  });

  it('skips with a WARN when the schema response has no properties object', async () => {
    writeSettings({ model: 'sonnet' });
    mockCurlSchema({ kind: 'no-properties' });
    const out = await runCheckSchema();
    expect(out).toContain(`${warnGlyph} schema check skipped`);
  });

  it('skips with a WARN when the schema payload is not JSON', async () => {
    writeSettings({ model: 'sonnet' });
    mockCurlSchema({ kind: 'garbage' });
    const out = await runCheckSchema();
    expect(out).toContain(`${warnGlyph} schema check skipped`);
  });

  it('emits OK when every settings key is in the published schema', async () => {
    writeSettings({ model: 'sonnet', env: {} });
    mockCurlSchema({ kind: 'json', keys: ['model', 'env', 'permissions'] });
    const out = await runCheckSchema();
    expect(out).toContain(`${okGlyph} settings.json keys all present in the published schema`);
  });

  it('WARNs and names keys absent from the published schema', async () => {
    writeSettings({ model: 'sonnet', inputNeededNotifEnabled: true });
    mockCurlSchema({ kind: 'json', keys: ['model', 'env'] });
    const out = await runCheckSchema();
    expect(out).toContain(`${warnGlyph} settings.json keys absent from published schema`);
    expect(out).toContain('inputNeededNotifEnabled');
    expect(out).not.toContain('model,');
  });
});
