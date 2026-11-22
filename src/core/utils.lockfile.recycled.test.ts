import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as fsModule from 'node:fs';

/** Returns this boot's id, or '' where /proc has none. */
function bootId(): string {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Returns this process's `<starttime>@<boot_id>` (start time is field 22 of
 * /proc/self/stat), read independently of the SUT.
 */
function selfIdentity(): string {
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const after = /\)([^)]*)$/.exec(stat)?.[1] ?? '';
  return `${after.trim().split(/\s+/)[19]}@${bootId()}`;
}

const hasProc = existsSync('/proc/self/stat');

/**
 * Makes every `/proc/` read through node:fs fail with ENOENT, as on a host with
 * no readable /proc. Other reads pass through.
 */
function mockProcUnreadable(): void {
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof fsModule>();
    return {
      ...actual,
      readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
        if (typeof args[0] === 'string' && args[0].startsWith('/proc/')) {
          const err = new Error('no such file') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return actual.readFileSync(...args);
      }),
    };
  });
}

/**
 * Lock liveness when the recorded pid was reused: the start time recorded in
 * the lock decides whether the owner is the same process. SUT loads from
 * ./utils.lockfile.ts.
 */
describe('acquireLock: recycled pid detection via recorded start time', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let lockDir: string;
  let lockPath: string;
  let stderrWrites: string[];

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-lockfile-recycled-'));
    process.env.HOME = testHome;
    lockDir = join(testHome, '.cache', 'claude-nomad');
    lockPath = join(lockDir, 'nomad.lock');
    stderrWrites = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderrWrites.push(args.map(String).join(' ') + '\n');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:fs');
    try {
      unlinkSync(lockPath);
    } catch {
      /* defensive cleanup; ignore */
    }
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  it.skipIf(!hasProc)('reaps a lock whose live pid carries a different start time', async () => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, `${process.pid} 1@not-this-boot`);
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    expect(readFileSync(lockPath, 'utf8')).toBe(`${process.pid} ${selfIdentity()}`);
    releaseLock(handle);
    expect(readdirSync(lockDir)).toEqual([]);
  });

  it.skipIf(!hasProc)('a fresh acquire records pid and start time', async () => {
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(readFileSync(lockPath, 'utf8')).toBe(`${process.pid} ${selfIdentity()}`);
    releaseLock(handle);
  });

  it.skipIf(!hasProc)('keeps a lock whose pid and start time both match', async () => {
    mkdirSync(lockDir, { recursive: true });
    const content = `${process.pid} ${selfIdentity()}`;
    writeFileSync(lockPath, content);
    const { acquireLock } = await import('./utils.lockfile.ts');
    expect(acquireLock('pull')).toBeNull();
    expect(stderrWrites.join('')).toContain('another nomad pull running, skipping');
    expect(readFileSync(lockPath, 'utf8')).toBe(content);
  });

  it.skipIf(!hasProc)('reaps a mismatched-start lock when kill reports EPERM', async () => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, `${process.pid} 1@not-this-boot`);
    vi.spyOn(process, 'kill').mockImplementation(((): boolean => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    }) as never);
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    releaseLock(handle);
  });

  it('treats the owner as alive when its current start time is unreadable', async () => {
    mkdirSync(lockDir, { recursive: true });
    const content = `${process.pid} 12345`;
    writeFileSync(lockPath, content);
    mockProcUnreadable();
    const { acquireLock } = await import('./utils.lockfile.ts');
    expect(acquireLock('pull')).toBeNull();
    expect(readFileSync(lockPath, 'utf8')).toBe(content);
  });

  it('writes the pid alone when the start time is unreadable', async () => {
    mockProcUnreadable();
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    releaseLock(handle);
    expect(readdirSync(lockDir)).toEqual([]);
  });

  it('parses the start time after the last paren of a comm holding spaces and parens', async () => {
    mkdirSync(lockDir, { recursive: true });
    const content = `${process.pid} 777@${bootId()}`;
    writeFileSync(lockPath, content);
    // Field 22 is 777; a split over the whole line would land elsewhere.
    const fields = ['S', ...Array.from({ length: 18 }, (_, i) => String(i + 100)), '777', '9', '9'];
    const stat = `${process.pid} (we) ird (na me) ${fields.join(' ')}`;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) =>
          args[0] === `/proc/${process.pid}/stat` ? stat : actual.readFileSync(...args),
        ),
      };
    });
    const { acquireLock } = await import('./utils.lockfile.ts');
    expect(acquireLock('pull')).toBeNull();
    expect(readFileSync(lockPath, 'utf8')).toBe(content);
  });

  it('reaps a two-field lock whose pid is dead', async () => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, '2147483647 1@some-boot');
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    expect(readFileSync(lockPath, 'utf8').split(' ')[0]).toBe(String(process.pid));
    releaseLock(handle);
    expect(readdirSync(lockDir)).toEqual([]);
  });
});
