/**
 * Tests for the `cmdDoctor` progress spinner (Option A: vanish, no success
 * glyph). They prove three load-bearing properties via an injected fake
 * spinner: the factory is called exactly once with the label 'Running checks',
 * the handle's `stop()` runs exactly once and BEFORE any stdout report line is
 * written, and the spinner label never leaks into the stdout report. A fourth
 * test exercises the default (real) factory branch on the CI/non-TTY plain
 * path to keep the `?? realStartSpinner` default covered.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SpinnerHandle } from './spinner.ts';
import {
  type Env,
  joinedLog,
  makeDoctorEnv,
  mockGitleaksPresent,
  restoreEnv,
} from './commands.doctor.checks.test-helpers.ts';

describe('cmdDoctor spinner', () => {
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
    // Empty path-map so the Path map / Shared links checks run cleanly.
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

  it('starts the spinner once with "Running checks", stops once, and never calls succeed', async () => {
    const stop = vi.fn();
    const succeed = vi.fn();
    const factory = vi.fn((_label: string): SpinnerHandle => ({ stop, succeed }));

    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ startSpinner: factory });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('Running checks');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(succeed).not.toHaveBeenCalled();
  });

  it('stops the spinner before any report line is written to stdout', async () => {
    // Snapshot the stdout (console.log) call count at the moment stop() runs.
    // It must be 0 (no report emitted yet); after cmdDoctor returns it must be
    // > 0 (report emitted only after stop returned).
    let logCallsWhenStopped = -1;
    const stop = vi.fn(() => {
      logCallsWhenStopped = env.logSpy.mock.calls.length;
    });
    const factory = (_label: string): SpinnerHandle => ({ stop, succeed: vi.fn() });

    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ startSpinner: factory });

    expect(logCallsWhenStopped).toBe(0);
    expect(env.logSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it('renders the normal report to stdout without leaking the spinner label', async () => {
    const factory = (_label: string): SpinnerHandle => ({ stop: vi.fn(), succeed: vi.fn() });

    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ startSpinner: factory });

    const out = joinedLog(env.logSpy);
    expect(out).toContain('Environment');
    expect(out).toContain('Repository');
    expect(out).not.toContain('Running checks');
  });

  it('defaults to the real spinner factory and still renders the report', async () => {
    // No startSpinner injected: the `?? realStartSpinner` default runs. Under
    // the non-TTY vitest runner the real spinner takes its plain path (one
    // stderr line, no worker), so the stdout report renders normally.
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();

    const out = joinedLog(env.logSpy);
    expect(out).toContain('Environment');
    expect(out).not.toContain('Running checks');
  });
});
