import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { git, setupForkRepo } from './commands.update.fork-extras.test-helpers.ts';

// Issue #112, secondary cases: `precommitForkExtras` must be a no-op when
// there is nothing to commit, so it never creates an empty commit ahead of
// the merge. Uses a REAL fork topology on disk; no git/npm stubbing because
// these cases call `precommitForkExtras` directly and assert HEAD is
// unchanged.
describe('issue #112: precommitForkExtras no-op cases', () => {
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNomadHost: string | undefined;
  let root: string;
  let local: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNomadHost = process.env.NOMAD_HOST;
    ({ root, local } = setupForkRepo());

    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(root, { recursive: true, force: true });
  });

  it('precommitForkExtras is a no-op when declared extras do not exist on disk', async () => {
    // path-map declares an extras dir that is not present on disk, so the
    // candidate set filters to empty and the helper returns before committing.
    writeFileSync(
      join(local, 'path-map.json'),
      JSON.stringify({ projects: {}, extras: { myproj: ['.planning'] } }) + '\n',
    );
    const before = git(local, ['rev-parse', 'HEAD']);
    vi.resetModules();
    const { precommitForkExtras } = await import('./update.fork-extras.ts');

    expect(() => precommitForkExtras()).not.toThrow();
    expect(git(local, ['rev-parse', 'HEAD'])).toBe(before);
  });

  it('precommitForkExtras is a no-op when extras are already tracked and unmodified', async () => {
    // The extras path exists and is already committed unchanged, so the
    // path-scoped `git add` stages nothing and the scoped dirty probe sees no
    // change: no empty commit is created.
    mkdirSync(join(local, 'shared', 'extras', 'myproj', '.planning'), { recursive: true });
    writeFileSync(join(local, 'shared', 'extras', 'myproj', '.planning', 'x.md'), '# tracked\n');
    git(local, ['add', '--', 'shared/extras/myproj/.planning/x.md']);
    git(local, ['commit', '-q', '-m', 'track extras']);
    writeFileSync(
      join(local, 'path-map.json'),
      JSON.stringify({ projects: {}, extras: { myproj: ['.planning'] } }) + '\n',
    );
    const before = git(local, ['rev-parse', 'HEAD']);
    vi.resetModules();
    const { precommitForkExtras } = await import('./update.fork-extras.ts');

    expect(() => precommitForkExtras()).not.toThrow();
    expect(git(local, ['rev-parse', 'HEAD'])).toBe(before);
  });
});
