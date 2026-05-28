import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type Env,
  joinedLog,
  makeDoctorEnv,
  mockGitleaksPresent,
  restoreEnv,
} from './commands.doctor.checks.test-helpers.ts';

describe('cmdDoctor --check-shared dispatch wiring', () => {
  // Dispatch-level wiring only: plain doctor must NOT scan (D-05), the flag
  // must append a "Shared scan" section. The deep check-shared behavior lives
  // in commands.doctor.check-shared.test.ts (plan 01) under a real-binary
  // gate; here we drive a zero-staged path-map so the reporter short-circuits
  // to a clean ok row without invoking the real gitleaks binary, and mock the
  // gitleaks probe present so the reporter does not WARN-skip on dev hosts.
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
    // Empty path-map so buildScanTree stages 0 sessions and reportCheckShared
    // short-circuits to a clean ok row (no real gitleaks invocation).
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: {} }) + '\n',
    );
    mockGitleaksPresent();
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

  it('does NOT emit a Shared scan section for plain cmdDoctor()', async () => {
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('Shared scan');
  });

  it('emits a Shared scan section when cmdDoctor({ checkShared: true })', async () => {
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ checkShared: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain('Shared scan');
  });

  it('does NOT emit a Schema scan section for plain cmdDoctor()', async () => {
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('Schema scan');
  });

  it('emits a Schema scan section when cmdDoctor({ checkSchema: true })', async () => {
    // No ~/.claude/settings.json in the sandbox, so reportCheckSchema short
    // -circuits to its info row before any network fetch; this still exercises
    // the dispatch wiring (the section renders only when the flag is set).
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ checkSchema: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain('Schema scan');
  });
});
