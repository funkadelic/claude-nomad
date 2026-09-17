import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as upstreamModule from './settings-upstream.ts';
import { g, gitInit, gitOut } from '../test-support/git.ts';

describe('preRebaseSettingsMerge', () => {
  let originalNomadHost: string | undefined;
  let repo: string;

  /** Write the given repo files (`null` deletes), commit, and return the SHA. */
  function commit(files: Record<string, string | null>): string {
    for (const [rel, content] of Object.entries(files)) {
      if (content === null) g(['rm', '-q', rel], repo);
      else writeFileSync(join(repo, rel), content);
    }
    g(['add', '-A'], repo);
    g(['commit', '-q', '--allow-empty', '-m', 'c'], repo);
    return gitOut(['rev-parse', 'HEAD'], repo);
  }

  /** Import the module fresh so `HOST` picks up `NOMAD_HOST`. */
  async function load(): Promise<typeof upstreamModule> {
    return import('./settings-upstream.ts');
  }

  beforeEach(() => {
    originalNomadHost = process.env.NOMAD_HOST;
    process.env.NOMAD_HOST = 'test-host';
    repo = mkdtempSync(join(tmpdir(), 'nomad-settings-upstream-'));
    mkdirSync(join(repo, 'shared'));
    mkdirSync(join(repo, 'hosts'));
    gitInit(repo);
    vi.resetModules();
  });

  afterEach(() => {
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns {} without reading git when heads are missing or equal', async () => {
    const { preRebaseSettingsMerge } = await load();
    expect(preRebaseSettingsMerge(repo, undefined)).toEqual({});
    expect(preRebaseSettingsMerge(repo, { pre: 'abc', post: 'abc' })).toEqual({});
  });

  it('returns the base at pre when no host file existed there', async () => {
    const pre = commit({ 'shared/settings.base.json': '{"model":"opus","statusLine":1}' });
    const post = commit({ 'shared/settings.base.json': '{"model":"opus"}' });
    const { preRebaseSettingsMerge } = await load();
    expect(preRebaseSettingsMerge(repo, { pre, post })).toEqual({ model: 'opus', statusLine: 1 });
  });

  it('merges the host file at pre over the base at pre', async () => {
    const pre = commit({
      'shared/settings.base.json': '{"model":"opus"}',
      'hosts/test-host.json': '{"model":"sonnet","theme":"dark"}',
    });
    const post = commit({ 'hosts/test-host.json': null });
    const { preRebaseSettingsMerge } = await load();
    expect(preRebaseSettingsMerge(repo, { pre, post })).toEqual({ model: 'sonnet', theme: 'dark' });
  });

  it('returns {} when git cannot read the pre commit', async () => {
    const post = commit({ 'shared/settings.base.json': '{"model":"opus"}' });
    const { preRebaseSettingsMerge } = await load();
    expect(preRebaseSettingsMerge(repo, { pre: 'f'.repeat(40), post })).toEqual({});
  });

  it.each([
    ['absent', null],
    ['malformed', '{ nope'],
    ['not an object', '["statusLine"]'],
  ])('returns {} when the base at pre is %s', async (_label, content) => {
    const pre = commit(content === null ? {} : { 'shared/settings.base.json': content });
    const post = commit({ 'shared/settings.base.json': '{"model":"opus"}' });
    const { preRebaseSettingsMerge } = await load();
    expect(preRebaseSettingsMerge(repo, { pre, post })).toEqual({});
  });

  it('returns {} when the host file at pre is malformed', async () => {
    const pre = commit({
      'shared/settings.base.json': '{"statusLine":1}',
      'hosts/test-host.json': '{ nope',
    });
    const post = commit({ 'hosts/test-host.json': '{}' });
    const { preRebaseSettingsMerge } = await load();
    expect(preRebaseSettingsMerge(repo, { pre, post })).toEqual({});
  });
});
