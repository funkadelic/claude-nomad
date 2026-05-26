import { rmSync } from 'node:fs';
import type * as fsModule from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  joinedLog,
  makeUpdateEnv,
  mockDoctor,
  mockGit,
  PRIVATE_SSH,
  PUBLIC_SSH,
  restoreEnv,
  type Env,
} from './commands.update.test-helpers.ts';

describe('cmdUpdate defaultPrompt (/dev/tty fallback)', () => {
  let originalHome: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    env = makeUpdateEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    vi.doUnmock('./commands.doctor.ts');
    restoreEnv('HOME', originalHome);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('defaultPrompt: /dev/tty `y\\n` triggers push to origin', async () => {
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      headShas: [
        '1111111111111111111111111111111111111111',
        '2222222222222222222222222222222222222222',
      ],
    });
    mockDoctor();
    // Silence the prompt's `process.stdout.write(question)` so the y/N
    // marker does not leak into the test runner's output.
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Mock node:fs to fake a TTY that yields the bytes "y\n". The mock
    // spreads the original module so existsSync/mkdir* etc. used elsewhere
    // in cmdUpdate (and by makeUpdateEnv) keep their real behavior.
    let bytePos = 0;
    const bytes = Buffer.from('y\n');
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        openSync: vi.fn(() => 999),
        readSync: vi.fn((_fd: number, buf: Buffer) => {
          if (bytePos >= bytes.length) return 0;
          buf[0] = bytes[bytePos++];
          return 1;
        }),
        closeSync: vi.fn(),
      };
    });
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate();
    expect(git.calls.map((c) => c.args.join(' '))).toContain('push origin main');
  });

  it('defaultPrompt: openSync failure returns empty string and skips push', async () => {
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      headShas: [
        '1111111111111111111111111111111111111111',
        '2222222222222222222222222222222222222222',
      ],
    });
    mockDoctor();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        openSync: vi.fn(() => {
          throw new Error('ENXIO: no /dev/tty');
        }),
      };
    });
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate();
    expect(git.calls.map((c) => c.args.join(' '))).not.toContain('push origin main');
    expect(joinedLog(env.logSpy)).toContain('skipping push to origin');
  });

  it('defaultPrompt: readSync returns 0 on first call yields empty answer', async () => {
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      headShas: [
        '1111111111111111111111111111111111111111',
        '2222222222222222222222222222222222222222',
      ],
    });
    mockDoctor();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        openSync: vi.fn(() => 999),
        // Immediate EOF: the loop's `if (n === 0) break;` arm fires before
        // any bytes are accumulated, so the prompt returns '' and runFork
        // treats it as "no" (skipping the push).
        readSync: vi.fn(() => 0),
        closeSync: vi.fn(),
      };
    });
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate();
    expect(git.calls.map((c) => c.args.join(' '))).not.toContain('push origin main');
    expect(joinedLog(env.logSpy)).toContain('skipping push to origin');
  });

  it('defaultPrompt: readSync throw is swallowed and returns empty string', async () => {
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      headShas: [
        '1111111111111111111111111111111111111111',
        '2222222222222222222222222222222222222222',
      ],
    });
    mockDoctor();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const closeSpy = vi.fn();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        openSync: vi.fn(() => 999),
        readSync: vi.fn(() => {
          throw new Error('EIO');
        }),
        closeSync: closeSpy,
      };
    });
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate();
    expect(git.calls.map((c) => c.args.join(' '))).not.toContain('push origin main');
    // Finally arm must run even when readSync throws.
    expect(closeSpy).toHaveBeenCalledWith(999);
  });
});
