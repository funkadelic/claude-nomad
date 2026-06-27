import { describe, expect, it } from 'vitest';

import { parseDoctorArgs } from './nomad.dispatch.doctor.ts';

// Behavior-focused: assert on the parsed shape for every argv tail the `doctor`
// dispatcher can receive. parseDoctorArgs is pure, so no mocking is needed.

describe('parseDoctorArgs', () => {
  it('parses an empty tail as a compact run with all flags off', () => {
    expect(parseDoctorArgs([])).toEqual({
      kind: 'run',
      checkShared: false,
      checkSchema: false,
      checkRemote: false,
      verbose: false,
    });
  });

  it('sets checkShared for --check-shared', () => {
    expect(parseDoctorArgs(['--check-shared'])).toEqual({
      kind: 'run',
      checkShared: true,
      checkSchema: false,
      checkRemote: false,
      verbose: false,
    });
  });

  it('sets checkSchema for --check-schema', () => {
    expect(parseDoctorArgs(['--check-schema'])).toEqual({
      kind: 'run',
      checkShared: false,
      checkSchema: true,
      checkRemote: false,
      verbose: false,
    });
  });

  it.each(['--verbose', '--all', '-v'])('sets verbose for %s', (flag) => {
    expect(parseDoctorArgs([flag])).toEqual({
      kind: 'run',
      checkShared: false,
      checkSchema: false,
      checkRemote: false,
      verbose: true,
    });
  });

  it('composes scan flags with a verbosity flag in any order', () => {
    expect(parseDoctorArgs(['--check-shared', '--check-schema', '--all'])).toEqual({
      kind: 'run',
      checkShared: true,
      checkSchema: true,
      checkRemote: false,
      verbose: true,
    });
  });

  it('sets checkRemote for --check-remote', () => {
    expect(parseDoctorArgs(['--check-remote'])).toEqual({
      kind: 'run',
      checkShared: false,
      checkSchema: false,
      checkRemote: true,
      verbose: false,
    });
  });

  it('composes --check-remote with --check-shared', () => {
    expect(parseDoctorArgs(['--check-remote', '--check-shared'])).toEqual({
      kind: 'run',
      checkShared: true,
      checkSchema: false,
      checkRemote: true,
      verbose: false,
    });
  });

  it('composes --check-remote with --verbose', () => {
    expect(parseDoctorArgs(['--check-remote', '--verbose'])).toEqual({
      kind: 'run',
      checkShared: false,
      checkSchema: false,
      checkRemote: true,
      verbose: true,
    });
  });

  it('returns error for an unknown token', () => {
    expect(parseDoctorArgs(['--bogus'])).toEqual({ kind: 'error' });
  });

  it('returns error when an unknown token follows a valid flag', () => {
    expect(parseDoctorArgs(['--verbose', 'extra'])).toEqual({ kind: 'error' });
  });

  it('parses --resume-cmd <id> as a resume', () => {
    expect(parseDoctorArgs(['--resume-cmd', 'sid-A'])).toEqual({ kind: 'resume', id: 'sid-A' });
  });

  it('returns error for --resume-cmd with no id', () => {
    expect(parseDoctorArgs(['--resume-cmd'])).toEqual({ kind: 'error' });
  });

  it('returns error for --resume-cmd with an empty id', () => {
    expect(parseDoctorArgs(['--resume-cmd', ''])).toEqual({ kind: 'error' });
  });

  it('returns error for --resume-cmd with a trailing arg', () => {
    expect(parseDoctorArgs(['--resume-cmd', 'sid-A', 'extra'])).toEqual({ kind: 'error' });
  });
});
