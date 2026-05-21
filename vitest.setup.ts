// Ensure picocolors initializes with color disabled so doctor-output
// substring assertions (`${glyph} <text>`) are not split by ANSI escape
// sequences in CI (where `CI=true` makes picocolors enable color by
// default). Setting NO_COLOR here runs before any test-file module loads,
// so the picocolors module read of `process.env.NO_COLOR` sees the value.
// Individual tests can still override NO_COLOR per-block via beforeEach
// + vi.resetModules() if they need to exercise color-enabled paths.
process.env.NO_COLOR ??= '1';
