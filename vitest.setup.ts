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
