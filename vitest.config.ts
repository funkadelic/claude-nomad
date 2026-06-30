import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.stryker-tmp/**'],
    // The default 5s timeout is too tight for the suites that spawn a fresh
    // Node subprocess (color probes, the find-zero-kill driver) or run real git
    // (the round-trip integration test): Node cold-start plus type-stripping can
    // take several seconds each, and they tip over 5s under thread-pool
    // contention. 20s gives real headroom; pure-logic tests finish in ms either
    // way, so the higher ceiling never slows the steady-state run.
    testTimeout: 20000,
    hookTimeout: 20000,
    // Cap worker oversubscription so the subprocess-heavy tests get scheduled
    // CPU instead of starving and timing out (also avoids the pool's own
    // "Timeout waiting for worker to respond" flake under load).
    maxWorkers: '50%',
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
        // worker_threads entry point: animation loop driven by postMessage.
        // Cannot be unit-instrumented without a real worker context.
        'src/spinner.worker.ts',
      ],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
    },
  },
});
