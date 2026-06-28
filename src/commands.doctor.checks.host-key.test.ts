import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { warnGlyph } from './color.ts';
import { reportHostKeyAlignment } from './commands.doctor.checks.repo.ts';
import { section } from './commands.doctor.format.ts';
import { HOST } from './config.ts';
import { restoreEnv } from './commands.doctor.checks.test-helpers.ts';

/**
 * `reportHostKeyAlignment` WARNs only when NOMAD_HOST is unset AND the
 * hostname-derived HOST key matches neither a `hosts/<HOST>.json` override nor a
 * `path-map.json` entry. Every other state stays silent. The frozen HOST
 * constant is used to key the fixture files so the assertions hold regardless of
 * the runner's actual hostname.
 */
describe('reportHostKeyAlignment', () => {
  let origHome: string | undefined;
  let origNomadHost: string | undefined;
  let origNomadRepo: string | undefined;
  let origNoColor: string | undefined;
  let testHome: string;

  /** Absolute path to the scaffolded sync repo for the current temp HOME. */
  function repo(): string {
    return join(testHome, 'claude-nomad');
  }

  /** Write `path-map.json` into the sync repo with the given raw string body. */
  function writePathMap(body: string): void {
    writeFileSync(join(repo(), 'path-map.json'), body);
  }

  beforeEach(() => {
    origHome = process.env.HOME;
    origNomadHost = process.env.NOMAD_HOST;
    origNomadRepo = process.env.NOMAD_REPO;
    origNoColor = process.env.NO_COLOR;
    // NO_COLOR so the warnGlyph substring assert is not split by ANSI escapes.
    process.env.NO_COLOR = '1';
    // Pin REPO_HOME to the temp HOME's sync repo, not an ambient override.
    delete process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-hostkey-'));
    process.env.HOME = testHome;
    mkdirSync(join(repo(), 'hosts'), { recursive: true });
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', origHome);
    restoreEnv('NOMAD_HOST', origNomadHost);
    restoreEnv('NOMAD_REPO', origNomadRepo);
    restoreEnv('NO_COLOR', origNoColor);
    rmSync(testHome, { recursive: true, force: true });
  });

  it('stays silent when NOMAD_HOST is set (a deliberate stable label)', () => {
    process.env.NOMAD_HOST = 'deliberate-label';
    const s = section('Environment');
    reportHostKeyAlignment(s);
    expect(s.items).toHaveLength(0);
  });

  it('stays silent when a hosts/<HOST>.json override exists', () => {
    delete process.env.NOMAD_HOST;
    writeFileSync(join(repo(), 'hosts', `${HOST}.json`), '{}');
    const s = section('Environment');
    reportHostKeyAlignment(s);
    expect(s.items).toHaveLength(0);
  });

  it('stays silent when path-map.json maps a project for this host', () => {
    delete process.env.NOMAD_HOST;
    writePathMap(JSON.stringify({ projects: { app: { [HOST]: '/abs/app' } } }));
    const s = section('Environment');
    reportHostKeyAlignment(s);
    expect(s.items).toHaveLength(0);
  });

  it('stays silent when the host key is present even with an empty path', () => {
    delete process.env.NOMAD_HOST;
    writePathMap(JSON.stringify({ projects: { app: { [HOST]: '' } } }));
    const s = section('Environment');
    reportHostKeyAlignment(s);
    expect(s.items).toHaveLength(0);
  });

  it('WARNs when unset with no host file and no path-map', () => {
    delete process.env.NOMAD_HOST;
    const s = section('Environment');
    reportHostKeyAlignment(s);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(warnGlyph);
    expect(s.items[0]).toContain('NOMAD_HOST unset');
    expect(process.exitCode).toBe(0);
  });

  it('WARNs when path-map.json is malformed JSON', () => {
    delete process.env.NOMAD_HOST;
    writePathMap('{ not valid json');
    const s = section('Environment');
    reportHostKeyAlignment(s);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain('NOMAD_HOST unset');
  });

  it('WARNs when path-map.json has an invalid shape', () => {
    delete process.env.NOMAD_HOST;
    writePathMap(JSON.stringify({ projects: [] }));
    const s = section('Environment');
    reportHostKeyAlignment(s);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain('NOMAD_HOST unset');
  });

  it('WARNs when path-map.json maps only other hosts', () => {
    delete process.env.NOMAD_HOST;
    writePathMap(JSON.stringify({ projects: { app: { 'other-host': '/abs/app' } } }));
    const s = section('Environment');
    reportHostKeyAlignment(s);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain('NOMAD_HOST unset');
  });
});
