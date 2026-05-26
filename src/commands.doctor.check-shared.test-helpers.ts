import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi } from 'vitest';

import { type PathMap } from './config.ts';

/** Shape of the section reportCheckShared appends rows to (mirrors DoctorSection). */
export type Section = { header: string; items: string[] };

/** Snapshot of the env vars a check-shared test mutates, captured by `saveEnv`. */
export type EnvSnapshot = {
  home: string | undefined;
  nomadHost: string | undefined;
  noColor: string | undefined;
};

/**
 * Build a sandbox HOME for a check-shared run: a temp `HOME` with the
 * `claude-nomad/` repo skeleton and a `.claude/projects/<encoded>/` session
 * dir. Returns the temp dir and the absolute local project path so callers can
 * write a path-map entry and a session JSONL. `encodePath` is `/` -> `-`.
 *
 * @returns The sandbox `testHome`, the logical `localPath`, and its `encodedDir`.
 */
export function makeEnv(): { testHome: string; localPath: string; encodedDir: string } {
  const testHome = mkdtempSync(join(tmpdir(), 'nomad-check-shared-'));
  process.env.HOME = testHome;
  process.env.NOMAD_HOST = 'test-host';
  mkdirSync(join(testHome, 'claude-nomad', 'shared'), { recursive: true });
  const localPath = '/srv/foo';
  const encodedDir = localPath.replaceAll('/', '-');
  mkdirSync(join(testHome, '.claude', 'projects', encodedDir), { recursive: true });
  return { testHome, localPath, encodedDir };
}

/**
 * Write a path-map.json mapping logical names to `{ host: path }` records.
 *
 * @param testHome The sandbox HOME whose `claude-nomad/path-map.json` is written.
 * @param projects The `projects` object to serialize.
 */
export function writePathMap(testHome: string, projects: PathMap['projects']): void {
  writeFileSync(
    join(testHome, 'claude-nomad', 'path-map.json'),
    JSON.stringify({ projects }) + '\n',
  );
}

/**
 * Snapshot HOME / NOMAD_HOST / NO_COLOR, force `NO_COLOR=1`, reset
 * `process.exitCode`, reset the module cache, and spy console.log to a no-op
 * (suppressing the `copyDirJsonlOnly` skip lines). Call in `beforeEach`.
 *
 * @returns The captured `EnvSnapshot` to pass back to `restoreEnv` in `afterEach`.
 */
export function saveEnv(): EnvSnapshot {
  const snapshot: EnvSnapshot = {
    home: process.env.HOME,
    nomadHost: process.env.NOMAD_HOST,
    noColor: process.env.NO_COLOR,
  };
  process.env.NO_COLOR = '1';
  process.exitCode = 0;
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {
    // Capture only; suppress copyDirJsonlOnly skip lines.
  });
  return snapshot;
}

/**
 * Reset `process.exitCode`, restore all spies/mocks, restore the env vars from
 * `snapshot`, and remove the sandbox `testHome`. Call in `afterEach`. Mock
 * `doUnmock` pairing for `node:*` modules is the caller's responsibility (it
 * varies per file).
 *
 * @param snapshot The `EnvSnapshot` returned by `saveEnv`.
 * @param testHome The sandbox HOME to remove (no-op if undefined/already gone).
 */
export function restoreEnv(snapshot: EnvSnapshot, testHome: string | undefined): void {
  process.exitCode = 0;
  vi.restoreAllMocks();
  if (snapshot.home !== undefined) process.env.HOME = snapshot.home;
  else delete process.env.HOME;
  if (snapshot.nomadHost !== undefined) process.env.NOMAD_HOST = snapshot.nomadHost;
  else delete process.env.NOMAD_HOST;
  if (snapshot.noColor !== undefined) process.env.NO_COLOR = snapshot.noColor;
  else delete process.env.NO_COLOR;
  if (testHome !== undefined) rmSync(testHome, { recursive: true, force: true });
}

/** A planted GitHub PAT (ghp_ + 36 chars), reliably flagged by default gitleaks
 * rules. Assembled at runtime so a contiguous PAT-shaped token never sits in
 * source-controlled bytes. Distinct body from the documented test-fixture
 * literal so the path-scoped allowlist does not swallow it. */
export const PLANTED_SECRET = ['gh', 'p_', 'BCcU4rgWmX3aPlSt9bN6yKzD7vH2eF8oG1qZ'].join('');

/**
 * Minimal .gitleaks.toml written into the fixture REPO_HOME for the
 * allowlist-only case. Carries the path-scoped allowlist (condition = AND) that
 * drops the documented test-fixture github-pat literal when it appears at a
 * `shared/projects/<logical>/*.jsonl` path. The literal is split so no
 * contiguous PAT-shaped token sits in source-controlled bytes.
 */
export const GITLEAKS_TOML = `[extend]
useDefault = true

[[allowlists]]
description = "test-fixture github-pat literals in synced session transcripts"
regexes = [
    '''${['gh', 'p_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('')}''',
]
paths = [
    '''^shared/projects/[^/]+/.*\\.jsonl$''',
]
condition = "AND"
`;
