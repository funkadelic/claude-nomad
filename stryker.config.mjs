// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  // Stryker cannot mutation test this repo on vitest 5: @stryker-mutator/vitest-runner
  // 10.0.0 runs zero tests per mutant, so everything comes back Survived and the score
  // collapses, which reads as a weak suite rather than a broken tool. Its
  // `peer vitest >=2.0.0` range does not catch it. Use a vitest 4 checkout until a
  // runner newer than 10.0.0 ships. Upstream: stryker-mutator/stryker-js#6210.
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  reporters: ['html', 'json', 'progress'],
  disableBail: true,
  incremental: true,
  ignorePatterns: ['dist', 'docs-site', 'coverage', 'reports', '.stryker-tmp'],
  vitest: {
    related: true, // flip to false if "no tests found" errors appear (Pitfall 1)
  },
  // disableTypeChecks: true is the default since v7; leave it unset
};

export default config;
