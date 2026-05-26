import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // Match both `*.test-helpers.ts` and split variants like
        // `*.test-helpers.git.ts` (test infrastructure, exercised indirectly
        // via the suites that import them, so not counted toward coverage).
        'src/**/*.test-helpers*.ts',
        // CLI entry point: argv dispatcher with process.exit fall-throughs.
        // Tests would mock process.exit and assert dispatch routing, which
        // duplicates what each cmd* function already covers behaviorally.
        'src/nomad.ts',
      ],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
    },
  },
});
