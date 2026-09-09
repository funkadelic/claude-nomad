import type { ExecFileSyncOptions } from 'node:child_process';

/**
 * Injectable subprocess seam every probe in the tree binds to, so tests can
 * mock without `vi.doMock` and without touching `execFileSync` on the real
 * shell. Default binds to `child_process.execFileSync` with the same
 * signature.
 */
export type SpawnSyncFn = (
  bin: string,
  args: readonly string[],
  opts?: ExecFileSyncOptions,
) => Buffer | string;
