import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodePath } from '../../core/utils.json.ts';

describe('reportScrubHint', () => {
  let home: string;
  const saved = {
    HOME: process.env.HOME,
    NOMAD_REPO: process.env.NOMAD_REPO,
    NOMAD_HOST: process.env.NOMAD_HOST,
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'nomad-scrub-hint-'));
    process.env.HOME = home;
    process.env.NOMAD_REPO = join(home, 'repo');
    process.env.NOMAD_HOST = 'hint-host';
    vi.resetModules();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('skips a match outside shared/projects and names the live transcript of the next one', async () => {
    const projectRoot = join(home, 'work', 'proj');
    mkdirSync(join(home, 'repo'), { recursive: true });
    writeFileSync(
      join(home, 'repo', 'path-map.json'),
      JSON.stringify({ projects: { proj: { 'hint-host': projectRoot } } }),
    );
    const live = join(home, '.claude', 'projects', encodePath(projectRoot), 'sid.jsonl');
    mkdirSync(join(live, '..'), { recursive: true });
    writeFileSync(live, '{}\n');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { reportScrubHint } = await import('./scrub-hint.ts');
    reportScrubHint('sid', ['shared/other/sid.jsonl', 'shared/projects/proj/sid.jsonl']);

    const out = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n');
    expect(out).toContain(`scrub ${live} manually`);
  });
});
