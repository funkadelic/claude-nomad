import { describe, expect, it } from 'vitest';

import { cmdUpdate } from './commands.update.ts';
import { NomadFatal } from './utils.ts';

describe('cmdUpdate', () => {
  it('calls npm update -g claude-nomad with no shell', () => {
    const calls: { bin: string; args: readonly string[] }[] = [];
    const run = (bin: string, args: readonly string[]) => {
      calls.push({ bin, args });
      return '';
    };

    cmdUpdate(run);

    expect(calls).toHaveLength(1);
    expect(calls[0].bin).toBe('npm');
    expect(calls[0].args).toEqual(['update', '-g', 'claude-nomad']);
  });

  it('throws NomadFatal when npm is not on PATH (ENOENT)', () => {
    const run = () => {
      const err = new Error('spawn npm ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };

    expect(() => cmdUpdate(run)).toThrow(NomadFatal);
    expect(() => cmdUpdate(run)).toThrow('npm not found on PATH');
  });

  it('throws NomadFatal on non-zero npm exit', () => {
    const run = () => {
      throw new Error('npm exited with code 1');
    };

    expect(() => cmdUpdate(run)).toThrow(NomadFatal);
    expect(() => cmdUpdate(run)).toThrow('npm update -g claude-nomad failed');
  });
});
