/**
 * Tests for the `cmdDoctor` progress spinner (Option A: vanish, no success
 * glyph). They prove three load-bearing properties via an injected fake
 * spinner: the factory is called exactly once with the label 'Running checks',
 * the handle's `stop()` runs exactly once and BEFORE any stdout report line is
 * written, and the spinner label never leaks into the stdout report. A fourth
 * test exercises the default (real) factory branch, pinning `CI=1` to force the
 * plain path deterministically, and asserts both halves of the stdout/stderr
 * invariant: the label is written to stderr and absent from the stdout report.
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
  let originalCI: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    originalCI = process.env.CI;
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
    restoreEnv('CI', originalCI);
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

  it('stops the spinner before the first report line is rendered to stdout', async () => {
    // Record the relative order of stop() and the first console.log (the first
    // line renderDoctor emits). stop() must appear in the sequence BEFORE any
    // 'log' entry, positively proving the spinner is torn down before render
    // begins rather than merely that no log preceded it.
    const sequence: string[] = [];
    let logCallsWhenStopped = -1;
    const stop = vi.fn(() => {
      logCallsWhenStopped = env.logSpy.mock.calls.length;
      sequence.push('stop');
    });
    env.logSpy.mockImplementation(() => {
      sequence.push('log');
    });
    const factory = (_label: string): SpinnerHandle => ({ stop, succeed: vi.fn() });

    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ startSpinner: factory });

    // No stdout line was written when stop() ran.
    expect(logCallsWhenStopped).toBe(0);
    // The report rendered (>= 1 line) only after stop() returned.
    expect(env.logSpy.mock.calls.length).toBeGreaterThan(0);
    // stop() precedes the first render line in the observed sequence.
    expect(sequence[0]).toBe('stop');
    expect(sequence.indexOf('stop')).toBeLessThan(sequence.indexOf('log'));
  });

  it('renders the normal report to stdout without leaking the spinner label', async () => {
    const factory = (_label: string): SpinnerHandle => ({ stop: vi.fn(), succeed: vi.fn() });

    const { cmdDoctor } = await import('./commands.doctor.ts');
    // verbose: render the full tree so the always-passing Repository section is
    // present (the compact default would hide a section with no WARN/FAIL).
    cmdDoctor({ startSpinner: factory, verbose: true });

    const out = joinedLog(env.logSpy);
    expect(out).toContain('Environment');
    expect(out).toContain('Repository');
    expect(out).not.toContain('Running checks');
  });

  it('defaults to the real spinner factory, writes the label to stderr, and renders the report', async () => {
    // No startSpinner injected: the `?? realStartSpinner` default runs. Pin
    // CI=1 so `animate = ttyCheck() && !env.CI` is false regardless of TTY
    // state, forcing the plain path (one stderr line, no worker) on every
    // machine. This makes the test deterministic instead of relying on the
    // vitest runner happening to be non-TTY.
    process.env.CI = '1';
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);

    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();

    // Positive half of invariant 1: the spinner label goes to STDERR.
    const stderrOut = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
    expect(stderrOut).toContain('Running checks');

    // Negative half: the label never leaks into the stdout report.
    const out = joinedLog(env.logSpy);
    expect(out).toContain('Environment');
    expect(out).not.toContain('Running checks');
  });
});
