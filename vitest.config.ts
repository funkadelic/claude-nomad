import { readdirSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Self-maintaining classification: any test file that touches a child-process
// API (spawning node's type-stripping probes, esbuild, real git, gitleaks)
// lands in the bounded "subprocess" project below instead of the fully
// parallel "unit" project, so a new subprocess-spawning test auto-isolates
// without a config edit. A file matching only inside a comment still lands
// here (harmless, just less parallelism); err toward isolation.
const SUBPROCESS_TOKEN_RE =
  /execFileSync|spawnSync|execSync|fork\(|spawn\(|experimental-strip-types|esbuild/;

function findTestFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...findTestFiles(path));
    } else if (entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

// Test files live in both src/ and scripts/ today (verified against the
// implicit default-include baseline), so both are scanned; a future nested
// test dir under either root is still found via the recursive walk.
const allTestFiles = [...findTestFiles('src'), ...findTestFiles('scripts')];
const subprocessTests = allTestFiles.filter((path) =>
  SUBPROCESS_TOKEN_RE.test(readFileSync(path, 'utf8')),
);

// setupFiles applies NO_COLOR and (on win32) deletes USERPROFILE; both
// projects need it explicitly since projects do not inherit root test options.
const SETUP_FILES = ['./vitest.setup.ts'];
const SHARED_EXCLUDE = ['**/node_modules/**', '**/dist/**', '.stryker-tmp/**'];

export default defineConfig({
  test: {
    exclude: SHARED_EXCLUDE,
    // Declared at the root (not per project) so the CLI is bundled exactly once
    // for the whole run and both projects spawn the same artifact.
    globalSetup: ['./vitest.globalSetup.ts'],
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: [...subprocessTests, ...SHARED_EXCLUDE],
          setupFiles: SETUP_FILES,
          sequence: { groupOrder: 0 },
          // Half the cores, not all of them: an uncapped pool spawning one
          // fork per core can miss the pool's worker-start deadline on a
          // contended machine ("Timeout waiting for worker to respond").
          maxWorkers: '50%',
          // Pure in-process tests: no subprocess contention, so a tighter
          // timeout surfaces a real hang faster instead of masking it.
          testTimeout: 10000,
          hookTimeout: 10000,
        },
      },
      {
        test: {
          name: 'subprocess',
          include: subprocessTests,
          exclude: SHARED_EXCLUDE,
          setupFiles: SETUP_FILES,
          sequence: { groupOrder: 1 },
          // Bounded low parallelism. Each file here spawns external children
          // (node cold-start plus type-stripping, esbuild, real git, gitleaks),
          // so real core demand per worker exceeds one. A fixed 2 keeps peak
          // demand inside the fast cores of older or asymmetric-core CPUs (where
          // work spilling onto slow/efficiency cores under contention is what
          // pushes the heavyweight round-trip test past its 20s ceiling),
          // while roughly halving this serial phase versus maxWorkers: 1. A
          // fixed count (not a percentage) is deliberate so the ceiling does
          // not scale up with core count and reopen that starvation risk.
          // Groups run in `sequence.groupOrder`, so this bounded phase also
          // never contends with the unit group's parallel phase.
          maxWorkers: 2,
          // Node cold-start plus type-stripping, esbuild, real git, and
          // gitleaks legitimately need headroom beyond the default 5s.
          testTimeout: 20000,
          hookTimeout: 20000,
        },
      },
    ],
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
