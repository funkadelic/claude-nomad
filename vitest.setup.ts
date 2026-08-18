import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll } from 'vitest';

// Ensure picocolors initializes with color disabled so doctor-output
// substring assertions (`${glyph} <text>`) are not split by ANSI escape
// sequences in CI (where `CI=true` makes picocolors enable color by
// default). Setting NO_COLOR here runs before any test-file module loads,
// so the picocolors module read of `process.env.NO_COLOR` sees the value.
// Individual tests can still override NO_COLOR per-block via beforeEach
// + vi.resetModules() if they need to exercise color-enabled paths.
process.env.NO_COLOR ??= '1';

// On win32, home() (src/config.ts) prefers USERPROFILE over HOME, but every
// test sandbox in this suite stamps only HOME. Deleting USERPROFILE here, at
// setup-file load, makes home()'s win32 branch fall through to the sandbox
// HOME instead of resolving the real runner profile, matching posix behavior
// without editing every individual sandbox. Tests that explicitly exercise
// the USERPROFILE-first branch (config.test.ts) set and restore USERPROFILE
// themselves per test, so their write wins during the test and this
// process-wide delete does not conflict with them.
if (process.platform === 'win32') {
  delete process.env.USERPROFILE;
}

// Every command in this codebase resolves its host-local state under HOME
// (`~/.claude/`, `~/.cache/claude-nomad/`), and a test that drives one without
// stamping its own sandbox writes into the developer's real home instead. That
// is silent: the run passes, and the damage shows up later as backup dirs,
// baseline caches and lockfiles nobody created by hand. Pointing HOME at a
// per-file temp dir here, before any test module loads, makes the omission
// harmless rather than invisible. A test that wants its own sandbox still sets
// HOME itself and restores this value afterwards.
const SUITE_HOME = mkdtempSync(join(tmpdir(), 'nomad-suite-home-'));
process.env.HOME = SUITE_HOME;

afterAll(() => {
  rmSync(SUITE_HOME, { recursive: true, force: true });
});
