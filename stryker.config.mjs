// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
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
