# Changelog

## [0.33.0](https://github.com/funkadelic/claude-nomad/compare/v0.32.4...v0.33.0) (2026-05-30)


### Added

* **dist:** run bin under node native type-stripping, drop tsx ([#198](https://github.com/funkadelic/claude-nomad/issues/198)) ([79b437d](https://github.com/funkadelic/claude-nomad/commit/79b437d8fee69d4f0f25394de9236f7c67289291))
* **help:** show CLI version at the top of default help ([#196](https://github.com/funkadelic/claude-nomad/issues/196)) ([f095d35](https://github.com/funkadelic/claude-nomad/commit/f095d354273122bc530aac5f486fdb9ad771341e))

## [0.32.4](https://github.com/funkadelic/claude-nomad/compare/v0.32.3...v0.32.4) (2026-05-30)


### Fixed

* **push:** honor drop-wins for allow in recovery dispatch ([#194](https://github.com/funkadelic/claude-nomad/issues/194)) ([9731ecf](https://github.com/funkadelic/claude-nomad/commit/9731ecf9b3d65a6f10fd3e7fc8e520f839640b25))

## [0.32.3](https://github.com/funkadelic/claude-nomad/compare/v0.32.2...v0.32.3) (2026-05-30)


### Fixed

* **push:** hard-block sensitive never-sync files under extras ([#191](https://github.com/funkadelic/claude-nomad/issues/191)) ([6509387](https://github.com/funkadelic/claude-nomad/commit/6509387b5724d13e8aa2122eb99cdd80e58da2ee))

## [0.32.2](https://github.com/funkadelic/claude-nomad/compare/v0.32.1...v0.32.2) (2026-05-30)


### Fixed

* **remap:** reject path-traversal in path-map logical keys ([#190](https://github.com/funkadelic/claude-nomad/issues/190)) ([1526fbb](https://github.com/funkadelic/claude-nomad/commit/1526fbbbb7c6beb258d882c1c26cd45447ab226b))


### Changed

* **sonar:** source projectVersion from package.json at scan time ([#188](https://github.com/funkadelic/claude-nomad/issues/188)) ([c00dd6a](https://github.com/funkadelic/claude-nomad/commit/c00dd6a5135a8753d56cf4165cf5b9782c9bde3e))

## [0.32.1](https://github.com/funkadelic/claude-nomad/compare/v0.32.0...v0.32.1) (2026-05-30)


### Fixed

* **redact:** make applyRedactions overlap-safe ([#186](https://github.com/funkadelic/claude-nomad/issues/186)) ([8da07d1](https://github.com/funkadelic/claude-nomad/commit/8da07d1ef58b7f6596ca479a3c57863fc75f35bb))

## [0.32.0](https://github.com/funkadelic/claude-nomad/compare/v0.31.0...v0.32.0) (2026-05-30)


### Added

* **adopt:** add nomad adopt for pre-existing local dirs ([#185](https://github.com/funkadelic/claude-nomad/issues/185)) ([251d5b7](https://github.com/funkadelic/claude-nomad/commit/251d5b71569315cbcf6ae073e29faecb4dbe5aa2))


### Documentation

* **readme:** note synced skills carry shims, not the tool engine ([#183](https://github.com/funkadelic/claude-nomad/issues/183)) ([695ba02](https://github.com/funkadelic/claude-nomad/commit/695ba029a92f397a1469ca1cf5f782e0b5bcecac))

## [0.31.0](https://github.com/funkadelic/claude-nomad/compare/v0.30.0...v0.31.0) (2026-05-29)


### Added

* **push:** interactive secret recovery on push and nomad redact ([#181](https://github.com/funkadelic/claude-nomad/issues/181)) ([4931e27](https://github.com/funkadelic/claude-nomad/commit/4931e27ba30998a02b123c71edc1315069c9181a))


### Changed

* **gitleaks:** allowlist SonarCloud issue-key tool-output noise in synced transcripts ([#179](https://github.com/funkadelic/claude-nomad/issues/179)) ([0f7d816](https://github.com/funkadelic/claude-nomad/commit/0f7d8161d4de3379cd6a4db00482f560c8b3f280))
* **settings-drift:** author PRs via app token and make regen idempotent ([#182](https://github.com/funkadelic/claude-nomad/issues/182)) ([062397c](https://github.com/funkadelic/claude-nomad/commit/062397c565926471eccc8e75f72d1ccf2e5cc8c0))

## [0.30.0](https://github.com/funkadelic/claude-nomad/compare/v0.29.1...v0.30.0) (2026-05-29)


### Added

* **doctor:** report gh and curl presence in Version Checks ([#175](https://github.com/funkadelic/claude-nomad/issues/175)) ([5163833](https://github.com/funkadelic/claude-nomad/commit/516383301dbd9c64cfc8f1c7a654655b61c29280))


### Changed

* widen npm-publish smoke-test propagation window ([#176](https://github.com/funkadelic/claude-nomad/issues/176)) ([f8b1eef](https://github.com/funkadelic/claude-nomad/commit/f8b1eef18dcee91fb894d2036c42356f82c76f79))

## [0.29.1](https://github.com/funkadelic/claude-nomad/compare/v0.29.0...v0.29.1) (2026-05-29)


### Fixed

* **doctor:** degrade gitleaks-absent probe to WARN, not FAIL ([#173](https://github.com/funkadelic/claude-nomad/issues/173)) ([320bb8a](https://github.com/funkadelic/claude-nomad/commit/320bb8a5d6f6c1f02207be8e186fe678f8e6f8bd))

## [0.29.0](https://github.com/funkadelic/claude-nomad/compare/v0.28.0...v0.29.0) (2026-05-29)


### Added

* sync hook scripts and tool support dirs across hosts ([#171](https://github.com/funkadelic/claude-nomad/issues/171)) ([e340fd2](https://github.com/funkadelic/claude-nomad/commit/e340fd221882f9107f4e10c3a64ccd7be4061a14))

## [0.28.0](https://github.com/funkadelic/claude-nomad/compare/v0.27.0...v0.28.0) (2026-05-28)


### Added

* **doctor:** settings schema drift tooling (auto-sync PR + --check-schema) ([#168](https://github.com/funkadelic/claude-nomad/issues/168)) ([ac4ac21](https://github.com/funkadelic/claude-nomad/commit/ac4ac21f90148d7261b0b907bfdad43b3758f9fd))


### Fixed

* **doctor:** resync KNOWN_SETTINGS_KEYS with official settings schema ([#166](https://github.com/funkadelic/claude-nomad/issues/166)) ([2b453e1](https://github.com/funkadelic/claude-nomad/commit/2b453e18c18520dd0a4df035ace3825709097bc1))
* drop-session scrub hint and README rendering/layout fixes ([#165](https://github.com/funkadelic/claude-nomad/issues/165)) ([0840ab4](https://github.com/funkadelic/claude-nomad/commit/0840ab408b72174b23532a0ea32c27df522cfe39))

## [0.27.0](https://github.com/funkadelic/claude-nomad/compare/v0.26.2...v0.27.0) (2026-05-28)


### Added

* **output:** grouped tree output for push/pull and dry-run leak preview ([#163](https://github.com/funkadelic/claude-nomad/issues/163)) ([fff6f1e](https://github.com/funkadelic/claude-nomad/commit/fff6f1e28116b072ee4eceda36d87c13f4c1bc1c))

## [0.26.2](https://github.com/funkadelic/claude-nomad/compare/v0.26.1...v0.26.2) (2026-05-28)


### Fixed

* **gitleaks:** condense push output and group doctor check-shared layout ([#161](https://github.com/funkadelic/claude-nomad/issues/161)) ([d9e5758](https://github.com/funkadelic/claude-nomad/commit/d9e57589f616e70b8e2d6249c957af55a25a578b))

## [0.26.1](https://github.com/funkadelic/claude-nomad/compare/v0.26.0...v0.26.1) (2026-05-27)


### Fixed

* **preview:** replace diffJsonStrings parallel walk with jsdiff LCS line diff ([#159](https://github.com/funkadelic/claude-nomad/issues/159)) ([d9c0dca](https://github.com/funkadelic/claude-nomad/commit/d9c0dcae7b417d069e826ce3b825e9f23115ba2d))
* **remap:** fail closed on path-map collisions in remapPush before any write ([#156](https://github.com/funkadelic/claude-nomad/issues/156)) ([db33157](https://github.com/funkadelic/claude-nomad/commit/db33157faa02b5439278ae4e92a02bd671faee72))


### Changed

* **codeql:** skip analysis on release-please PR branches ([#160](https://github.com/funkadelic/claude-nomad/issues/160)) ([2bfed46](https://github.com/funkadelic/claude-nomad/commit/2bfed463ccd76f6331e5ab775bbd5d19df2898e9))
* **tests:** skip PR-time test matrix on release-please PR branches ([#158](https://github.com/funkadelic/claude-nomad/issues/158)) ([222e27b](https://github.com/funkadelic/claude-nomad/commit/222e27b2643382136505f72e148c17c7ecb7a08f))

## [0.26.0](https://github.com/funkadelic/claude-nomad/compare/v0.25.5...v0.26.0) (2026-05-27)


### Added

* **doctor:** readability pass on doctor output ([#154](https://github.com/funkadelic/claude-nomad/issues/154)) ([d4bb912](https://github.com/funkadelic/claude-nomad/commit/d4bb912180dbae8e12dfafb4ddd71abb54d0d441))

## [0.25.5](https://github.com/funkadelic/claude-nomad/compare/v0.25.4...v0.25.5) (2026-05-27)


### Fixed

* **gh-actions:** distinguish probe errors from not-authed ([#153](https://github.com/funkadelic/claude-nomad/issues/153)) ([14f11df](https://github.com/funkadelic/claude-nomad/commit/14f11df208e7996ddd92ffb79c14cd34707b552c))


### Changed

* **eslint:** gate on cognitive complexity, demote line cap to advisory ([#151](https://github.com/funkadelic/claude-nomad/issues/151)) ([43c8130](https://github.com/funkadelic/claude-nomad/commit/43c81309759247f2bca4b90358bf88667e778724))
* resolve SonarCloud code-smell findings ([#152](https://github.com/funkadelic/claude-nomad/issues/152)) ([497ab64](https://github.com/funkadelic/claude-nomad/commit/497ab646bd56c11c695957400322c4c802a73b1d))


### Documentation

* lint and wrap Markdown, refresh badges, document --version ([#149](https://github.com/funkadelic/claude-nomad/issues/149)) ([a8b2636](https://github.com/funkadelic/claude-nomad/commit/a8b2636a7e54f0384b5d0d0a931adf29d2a3a8ac))

## [0.25.4](https://github.com/funkadelic/claude-nomad/compare/v0.25.3...v0.25.4) (2026-05-27)


### Documentation

* **readme:** clarify setup docs, reduce jargon, add $ command prompts ([#147](https://github.com/funkadelic/claude-nomad/issues/147)) ([d590833](https://github.com/funkadelic/claude-nomad/commit/d590833e9a2cc1503651b2a4468ca6e8269fd57c))

## [0.25.3](https://github.com/funkadelic/claude-nomad/compare/v0.25.2...v0.25.3) (2026-05-26)


### Changed

* **config:** add skipAutoPermissionPrompt to KNOWN_SETTINGS_KEYS ([#142](https://github.com/funkadelic/claude-nomad/issues/142)) ([09b4d7c](https://github.com/funkadelic/claude-nomad/commit/09b4d7c27d74cc922f9c516296ca6123e1ee84f5))


### Documentation

* document runtime deps and foreground the security posture ([#145](https://github.com/funkadelic/claude-nomad/issues/145)) ([fb029ee](https://github.com/funkadelic/claude-nomad/commit/fb029eec1a6d915224a39cc2755ff76e42618365))
* refresh hero.svg tagline and doctor mockup ([#144](https://github.com/funkadelic/claude-nomad/issues/144)) ([58a0176](https://github.com/funkadelic/claude-nomad/commit/58a01760e8d977ce4cf46dcd3137c02f3bc6541c))

## [0.25.2](https://github.com/funkadelic/claude-nomad/compare/v0.25.1...v0.25.2) (2026-05-26)


### Fixed

* pre-existing robustness fixes from PR [#136](https://github.com/funkadelic/claude-nomad/issues/136) review ([#140](https://github.com/funkadelic/claude-nomad/issues/140)) ([bf4f443](https://github.com/funkadelic/claude-nomad/commit/bf4f443c50a47efafbb350d45d0e5d6883374f8d))

## [0.25.1](https://github.com/funkadelic/claude-nomad/compare/v0.25.0...v0.25.1) (2026-05-26)


### Fixed

* **doctor:** scan --check-shared like push to fix false negatives ([#134](https://github.com/funkadelic/claude-nomad/issues/134)) ([5063028](https://github.com/funkadelic/claude-nomad/commit/5063028c6a695709f7f2d2dfe3cceabedecc17f9))


### Changed

* split over-cap source and test files under the ~200-line cap ([#136](https://github.com/funkadelic/claude-nomad/issues/136)) ([0cc7eed](https://github.com/funkadelic/claude-nomad/commit/0cc7eed13abbc85084b04cfc8b686e53b26133c6))

## [0.25.0](https://github.com/funkadelic/claude-nomad/compare/v0.24.0...v0.25.0) (2026-05-25)


### Added

* **doctor:** add gitleaks version and mirror-Actions drift checks ([#125](https://github.com/funkadelic/claude-nomad/issues/125)) ([8a16e0c](https://github.com/funkadelic/claude-nomad/commit/8a16e0c274bb7b961c6fd2df9912874c572023ee))
* **extras:** support a single root file as an extras entry ([#132](https://github.com/funkadelic/claude-nomad/issues/132)) ([6303b62](https://github.com/funkadelic/claude-nomad/commit/6303b62de84406da6a7fa2b7eb7af28a0473d0aa))


### Fixed

* **drop-session:** cascade unstage into subagent transcript directory ([#120](https://github.com/funkadelic/claude-nomad/issues/120)) ([7f10d51](https://github.com/funkadelic/claude-nomad/commit/7f10d5135a7eaa9b6e74fb1aa863506a7b914a09))
* **push,update:** handle untracked extras in allow-list and fork merge ([#122](https://github.com/funkadelic/claude-nomad/issues/122)) ([e710a48](https://github.com/funkadelic/claude-nomad/commit/e710a48973a7c4e7479a9671d5891458a182dac7))
* **update:** skip push prompt when fork merge is a no-op ([#123](https://github.com/funkadelic/claude-nomad/issues/123)) ([77fdb20](https://github.com/funkadelic/claude-nomad/commit/77fdb20244a096e44a1fecd0a283e3401a78972d))


### Changed

* pin workflow actions to SHAs and drop persisted CI credentials ([#130](https://github.com/funkadelic/claude-nomad/issues/130)) ([b60109c](https://github.com/funkadelic/claude-nomad/commit/b60109c0cbb5dff1b13c4155cc12c3d98ce1b141))


### Documentation

* add CONTRIBUTING, PR template, and SECURITY policy ([#131](https://github.com/funkadelic/claude-nomad/issues/131)) ([774eb58](https://github.com/funkadelic/claude-nomad/commit/774eb58a36af032f7d1cd109d59f313c4ff6affa))
* lead README with a benefit-first pitch ([#133](https://github.com/funkadelic/claude-nomad/issues/133)) ([289e299](https://github.com/funkadelic/claude-nomad/commit/289e2994fd7dffb10818fe02aad64b193ad800b6))
* **readme:** foreground secret-safety in the intro ([#126](https://github.com/funkadelic/claude-nomad/issues/126)) ([e661e9f](https://github.com/funkadelic/claude-nomad/commit/e661e9f02247fc30630fd90d5facc65aa7b4f2a0))


### Dependencies

* bump SonarSource/sonarqube-scan-action from 8.0.0 to 8.1.0 ([#127](https://github.com/funkadelic/claude-nomad/issues/127)) ([603f20d](https://github.com/funkadelic/claude-nomad/commit/603f20d9a22528c8df19d328c91a02012690836c))
* bump the dev-dependencies group across 1 directory with 2 updates ([#128](https://github.com/funkadelic/claude-nomad/issues/128)) ([50b1b87](https://github.com/funkadelic/claude-nomad/commit/50b1b87b7288eed60280843504e6ccc2598f10b0))
* bump tsx from 4.22.2 to 4.22.3 in the prod-dependencies group ([#129](https://github.com/funkadelic/claude-nomad/issues/129)) ([a7ada00](https://github.com/funkadelic/claude-nomad/commit/a7ada000ec2d3dbee132c7b61dc207012e53c1c3))

## [0.24.0](https://github.com/funkadelic/claude-nomad/compare/v0.23.0...v0.24.0) (2026-05-24)


### Added

* **doctor:** add --check-shared preflight gitleaks scan ([#117](https://github.com/funkadelic/claude-nomad/issues/117)) ([0089d09](https://github.com/funkadelic/claude-nomad/commit/0089d09ef91ff7b6778b065bcfe8be97f4c54d1b))


### Documentation

* **readme:** document nomad doctor --check-shared preflight ([#119](https://github.com/funkadelic/claude-nomad/issues/119)) ([d08ed91](https://github.com/funkadelic/claude-nomad/commit/d08ed91bbfd4c976f56c510b086e375c4595e682))

## [0.23.0](https://github.com/funkadelic/claude-nomad/compare/v0.22.3...v0.23.0) (2026-05-23)


### Added

* **doctor:** warn when host node is below engines.node minimum ([#116](https://github.com/funkadelic/claude-nomad/issues/116)) ([3caf8d0](https://github.com/funkadelic/claude-nomad/commit/3caf8d09362b2f290af3d0efd9ea79a64aac39c1))


### Changed

* **tests:** add lockfile drift gate to catch release-please mismatches ([#114](https://github.com/funkadelic/claude-nomad/issues/114)) ([5847553](https://github.com/funkadelic/claude-nomad/commit/58475538ed405e1d2d1d00662ea6730ad124da42))

## [0.22.3](https://github.com/funkadelic/claude-nomad/compare/v0.22.2...v0.22.3) (2026-05-23)


### Changed

* **deps:** resync package-lock with manifest after 0.22.2 ([#109](https://github.com/funkadelic/claude-nomad/issues/109)) ([7317fd4](https://github.com/funkadelic/claude-nomad/commit/7317fd4bb375c5a5fb9c05c327fc75423946b0f0))

## [0.22.2](https://github.com/funkadelic/claude-nomad/compare/v0.22.1...v0.22.2) (2026-05-23)


### Fixed

* **gitleaks:** allowlist entropy-variant placeholders alongside the canonical PAT literal ([#107](https://github.com/funkadelic/claude-nomad/issues/107)) ([cb3bd59](https://github.com/funkadelic/claude-nomad/commit/cb3bd5923669aaf758d37afb5ed8f82261472d3a))

## [0.22.1](https://github.com/funkadelic/claude-nomad/compare/v0.22.0...v0.22.1) (2026-05-23)


### Fixed

* **gitignore:** anchor .planning/ to source repo root ([#105](https://github.com/funkadelic/claude-nomad/issues/105)) ([50c403d](https://github.com/funkadelic/claude-nomad/commit/50c403d7223f79f30fa28b99ce6e5b2dcc350356))

## [0.22.0](https://github.com/funkadelic/claude-nomad/compare/v0.21.0...v0.22.0) (2026-05-23)


### Added

* **extras-sync:** sync per-project .planning/ directories across hosts ([#103](https://github.com/funkadelic/claude-nomad/issues/103)) ([4563fe3](https://github.com/funkadelic/claude-nomad/commit/4563fe32a143dd9a2450baab8ec94a902800c2b3))

## [0.21.0](https://github.com/funkadelic/claude-nomad/compare/v0.20.0...v0.21.0) (2026-05-22)


### Added

* **config:** add settings.local.json to NEVER_SYNC ([#100](https://github.com/funkadelic/claude-nomad/issues/100)) ([26c7dc1](https://github.com/funkadelic/claude-nomad/commit/26c7dc1ef15206056349d117395cd22a4ee5bd84))


### Changed

* **utils:** drop unused writeJson helper ([#101](https://github.com/funkadelic/claude-nomad/issues/101)) ([168a9d7](https://github.com/funkadelic/claude-nomad/commit/168a9d7a582e3cd8ff97e26ac32c9ee4adad1a0d))

## [0.20.0](https://github.com/funkadelic/claude-nomad/compare/v0.19.0...v0.20.0) (2026-05-22)


### Added

* **update:** prompted auto-resolve for release-please artifact conflicts ([#98](https://github.com/funkadelic/claude-nomad/issues/98)) ([958cbf1](https://github.com/funkadelic/claude-nomad/commit/958cbf19839f1bda8ad0e25db0bb8495a88c2ee9))

## [0.19.0](https://github.com/funkadelic/claude-nomad/compare/v0.18.0...v0.19.0) (2026-05-22)


### Added

* **update:** auto-resolve sole package-lock.json merge conflict ([#96](https://github.com/funkadelic/claude-nomad/issues/96)) ([8d76be9](https://github.com/funkadelic/claude-nomad/commit/8d76be9791b427484d709d97a5d077539c0f9f1a))

## [0.18.0](https://github.com/funkadelic/claude-nomad/compare/v0.17.2...v0.18.0) (2026-05-22)


### Added

* **init:** auto-disable GitHub Actions on private mirror ([#94](https://github.com/funkadelic/claude-nomad/issues/94)) ([aee4736](https://github.com/funkadelic/claude-nomad/commit/aee47365f504c4700a619a2828c6fca8c18b1868))

## [0.17.2](https://github.com/funkadelic/claude-nomad/compare/v0.17.1...v0.17.2) (2026-05-22)


### Fixed

* **ci:** retry smoke-test install for registry propagation ([#92](https://github.com/funkadelic/claude-nomad/issues/92)) ([1ae7576](https://github.com/funkadelic/claude-nomad/commit/1ae75760f674e93be1fadc2b927ee4dd03f9d346))

## [0.17.1](https://github.com/funkadelic/claude-nomad/compare/v0.17.0...v0.17.1) (2026-05-21)


### Fixed

* **update:** explain y/N in push-merge prompt ([#90](https://github.com/funkadelic/claude-nomad/issues/90)) ([ab53960](https://github.com/funkadelic/claude-nomad/commit/ab5396041210f3770b34121c9875b38580ffc903))

## [0.17.0](https://github.com/funkadelic/claude-nomad/compare/v0.16.1...v0.17.0) (2026-05-21)


### Added

* ship to npm with bin shim and NOMAD_REPO override ([#88](https://github.com/funkadelic/claude-nomad/issues/88)) ([62b4ca3](https://github.com/funkadelic/claude-nomad/commit/62b4ca33a763efc39408f5f1fdbc50e2a1985e70))

## [0.16.1](https://github.com/funkadelic/claude-nomad/compare/v0.16.0...v0.16.1) (2026-05-21)


### Changed

* **output:** unify CLI output with doctor-style status glyphs ([#85](https://github.com/funkadelic/claude-nomad/issues/85)) ([98d6f6e](https://github.com/funkadelic/claude-nomad/commit/98d6f6edfc44bc9bc5f53e6ad8c1b3d04867d880))

## [0.16.0](https://github.com/funkadelic/claude-nomad/compare/v0.15.0...v0.16.0) (2026-05-21)


### Added

* **gitleaks:** recoverable UX for session JSONLs ([#83](https://github.com/funkadelic/claude-nomad/issues/83)) ([ef30db8](https://github.com/funkadelic/claude-nomad/commit/ef30db8ba4c599643769f3554b16e5cf6579c457))

## [0.15.0](https://github.com/funkadelic/claude-nomad/compare/v0.14.3...v0.15.0) (2026-05-21)


### Added

* **doctor:** version-first ordering and unified glyph gutter ([#80](https://github.com/funkadelic/claude-nomad/issues/80)) ([8b546a8](https://github.com/funkadelic/claude-nomad/commit/8b546a8a2812be5987628d6349b3757717c87d1b))


### Changed

* drop push: main triggers from codeql and lint workflows ([#82](https://github.com/funkadelic/claude-nomad/issues/82)) ([7386735](https://github.com/funkadelic/claude-nomad/commit/738673578758a63011ee7e4db332eafb9e348a4a))

## [0.14.3](https://github.com/funkadelic/claude-nomad/compare/v0.14.2...v0.14.3) (2026-05-20)


### Changed

* bump Node engine floor to 22.22.1 (lint-staged@17 requirement) ([#78](https://github.com/funkadelic/claude-nomad/issues/78)) ([2724afe](https://github.com/funkadelic/claude-nomad/commit/2724afe8f545fd02374114852f40e18139d6d2e6))

## [0.14.2](https://github.com/funkadelic/claude-nomad/compare/v0.14.1...v0.14.2) (2026-05-20)


### Testing

* close coverage gaps in utils, color, commands, push-checks, remap ([#76](https://github.com/funkadelic/claude-nomad/issues/76)) ([e392106](https://github.com/funkadelic/claude-nomad/commit/e3921069dea3148d5aabfa1553785731954c334e))

## [0.14.1](https://github.com/funkadelic/claude-nomad/compare/v0.14.0...v0.14.1) (2026-05-20)


### Testing

* **doctor:** isolate schema-failure exit-code from gitleaks state ([#74](https://github.com/funkadelic/claude-nomad/issues/74)) ([0148640](https://github.com/funkadelic/claude-nomad/commit/014864095b16440aa598072c6824059b4135fd75))

## [0.14.0](https://github.com/funkadelic/claude-nomad/compare/v0.13.0...v0.14.0) (2026-05-20)


### Added

* **resume:** resolve sessions started in subdirectories of mapped projects ([#73](https://github.com/funkadelic/claude-nomad/issues/73)) ([91ca332](https://github.com/funkadelic/claude-nomad/commit/91ca332e438829ea5a421f4eb9d9803c76557b2d))


### Fixed

* validate path-map schema before iteration ([#72](https://github.com/funkadelic/claude-nomad/issues/72)) ([9459fc3](https://github.com/funkadelic/claude-nomad/commit/9459fc370b68361a451f454883e3db28b0ebc7d2))


### Changed

* apply SonarQube minor cleanups ([#71](https://github.com/funkadelic/claude-nomad/issues/71)) ([aa36999](https://github.com/funkadelic/claude-nomad/commit/aa36999261d200881c043a331c78f60aeb30017c))
* **doctor:** tree-style output, drop [nomad] prefix ([#69](https://github.com/funkadelic/claude-nomad/issues/69)) ([329858e](https://github.com/funkadelic/claude-nomad/commit/329858e3510731b6e18c012755963d63f3f672b5))
* reduce cognitive complexity in doctor and resume ([#70](https://github.com/funkadelic/claude-nomad/issues/70)) ([e060fff](https://github.com/funkadelic/claude-nomad/commit/e060ffffcce247a0166fb2bdf71d5e15062aaece))


### Documentation

* **readme:** document nomad update and doctor version-check ([#67](https://github.com/funkadelic/claude-nomad/issues/67)) ([ce20fdd](https://github.com/funkadelic/claude-nomad/commit/ce20fdd8a14a45954f1d1c133a0a0d01c649fcc9))

## [0.13.0](https://github.com/funkadelic/claude-nomad/compare/v0.12.0...v0.13.0) (2026-05-20)


### Added

* **update:** add nomad update command for topology-aware upgrade ([#62](https://github.com/funkadelic/claude-nomad/issues/62)) ([689c10f](https://github.com/funkadelic/claude-nomad/commit/689c10f86496b8ea3bf25efed29d46d95c9f9dd1))


### Documentation

* **update:** add JSDoc to nomad update helpers ([#65](https://github.com/funkadelic/claude-nomad/issues/65)) ([e26fb7b](https://github.com/funkadelic/claude-nomad/commit/e26fb7b390790df2670b363a8e3dc7664322c7e9))

## [0.12.0](https://github.com/funkadelic/claude-nomad/compare/v0.11.2...v0.12.0) (2026-05-20)


### Added

* **doctor:** warn when local install is behind the latest release ([#60](https://github.com/funkadelic/claude-nomad/issues/60)) ([cd017f7](https://github.com/funkadelic/claude-nomad/commit/cd017f744cc65f114d2c68783d7bb9a5d23844df))

## [0.11.2](https://github.com/funkadelic/claude-nomad/compare/v0.11.1...v0.11.2) (2026-05-19)


### Changed

* **doctor:** extract per-check helpers to reduce cognitive complexity ([#58](https://github.com/funkadelic/claude-nomad/issues/58)) ([0876747](https://github.com/funkadelic/claude-nomad/commit/08767470d1c6c8406f528e962f8727fac9187f1d))

## [0.11.1](https://github.com/funkadelic/claude-nomad/compare/v0.11.0...v0.11.1) (2026-05-19)


### Changed

* **labeler:** exclude release-please PRs from dependencies label ([#56](https://github.com/funkadelic/claude-nomad/issues/56)) ([d4f1266](https://github.com/funkadelic/claude-nomad/commit/d4f126624589f119fa49f8769a7ba2f32e5a0368))


### Documentation

* **nomad:** expand default help output ([#54](https://github.com/funkadelic/claude-nomad/issues/54)) ([f535d8b](https://github.com/funkadelic/claude-nomad/commit/f535d8b69e44c589be5424bf40ccf2bfd09bf4c7))
* **readme:** add tests, release, coverage badges ([#57](https://github.com/funkadelic/claude-nomad/issues/57)) ([d87136b](https://github.com/funkadelic/claude-nomad/commit/d87136ba70a298731e1eaa1b475d2370cedf70a1))

## [0.11.0](https://github.com/funkadelic/claude-nomad/compare/v0.10.0...v0.11.0) (2026-05-19)


### Added

* **push:** add nomad push --dry-run flag ([#52](https://github.com/funkadelic/claude-nomad/issues/52)) ([560fa47](https://github.com/funkadelic/claude-nomad/commit/560fa4702e5bcf1f5c97314a9b7e66671c766a35))

## [0.10.0](https://github.com/funkadelic/claude-nomad/compare/v0.9.2...v0.10.0) (2026-05-19)


### Added

* **doctor:** mark every check-result line with an explicit PASS token ([#47](https://github.com/funkadelic/claude-nomad/issues/47)) ([f33c034](https://github.com/funkadelic/claude-nomad/commit/f33c034b3339831f0a9397022c35ba0c7b7166e0))
* **init:** add nomad init --snapshot mode ([#49](https://github.com/funkadelic/claude-nomad/issues/49)) ([35fd279](https://github.com/funkadelic/claude-nomad/commit/35fd2798d6b38e1945a16666196a316e02a07b4b))
* **init:** add nomad init verb, first-run FATAL, doctor repo state header ([#45](https://github.com/funkadelic/claude-nomad/issues/45)) ([f37cf95](https://github.com/funkadelic/claude-nomad/commit/f37cf95ebed2379a1c1550578f0428fdd773a99e))
* **pull,diff:** add nomad pull --dry-run and nomad diff verb ([#48](https://github.com/funkadelic/claude-nomad/issues/48)) ([bfcf457](https://github.com/funkadelic/claude-nomad/commit/bfcf457654a5b93f49c91b8531822e51e4eed7ce))
* **summary:** add end-of-run summary line for pull, push, diff ([#50](https://github.com/funkadelic/claude-nomad/issues/50)) ([90f294c](https://github.com/funkadelic/claude-nomad/commit/90f294ca7a7b7c93bcd054477a578b60942d4e67))


### Documentation

* **readme:** document nomad init, diff, dry-run, doctor PASS, summary line ([#51](https://github.com/funkadelic/claude-nomad/issues/51)) ([adeeb29](https://github.com/funkadelic/claude-nomad/commit/adeeb29493c8a085a80719df01d9423f817c682e))

## [0.9.2](https://github.com/funkadelic/claude-nomad/compare/v0.9.1...v0.9.2) (2026-05-19)


### Changed

* **commands:** split commands.ts into pull/push/doctor modules ([#42](https://github.com/funkadelic/claude-nomad/issues/42)) ([71e3259](https://github.com/funkadelic/claude-nomad/commit/71e3259a9f9777ffe813f16fda3fed3d4ec5c09b))


### Documentation

* **readme:** surface trade-offs section before Setup, add TOC ([#43](https://github.com/funkadelic/claude-nomad/issues/43)) ([9fdf79f](https://github.com/funkadelic/claude-nomad/commit/9fdf79ff19db37d6c23548e697c1d64b40605f11))

## [0.9.1](https://github.com/funkadelic/claude-nomad/compare/v0.9.0...v0.9.1) (2026-05-18)


### Changed

* **release-please:** authenticate via GitHub App so PRs trigger CI ([#40](https://github.com/funkadelic/claude-nomad/issues/40)) ([8ab97b9](https://github.com/funkadelic/claude-nomad/commit/8ab97b92c917b9a0d8dd65d809c6563121853c53))

## [0.9.0](https://github.com/funkadelic/claude-nomad/compare/v0.8.0...v0.9.0) (2026-05-18)


### Added

* **release-please:** route Dependabot updates to a Dependencies section ([#35](https://github.com/funkadelic/claude-nomad/issues/35)) ([a04c2e9](https://github.com/funkadelic/claude-nomad/commit/a04c2e926e7263a416452ca3824e7926eec44fcd))


### Changed

* add tests, lint, codeql, labeler, dependabot, pr-title, codecov workflows ([#28](https://github.com/funkadelic/claude-nomad/issues/28)) ([88a7f0b](https://github.com/funkadelic/claude-nomad/commit/88a7f0bf36c19ae817631da60e169b58db13e39f))
* **dependabot:** drop include:scope to avoid redundant deps(deps) titles ([#37](https://github.com/funkadelic/claude-nomad/issues/37)) ([d49d20f](https://github.com/funkadelic/claude-nomad/commit/d49d20f526b507aaa4962cc3ffc4d9794d62b48e))
* **dependabot:** pin @types/node major to track supported runtime ([#38](https://github.com/funkadelic/claude-nomad/issues/38)) ([026ab83](https://github.com/funkadelic/claude-nomad/commit/026ab833c97cb057984d8b536813efafc1672f55))
* **deps-dev:** bump lint-staged from 16.4.0 to 17.0.5 ([#34](https://github.com/funkadelic/claude-nomad/issues/34)) ([f08de47](https://github.com/funkadelic/claude-nomad/commit/f08de4737f0a28dd816ca812dda09aac0f25829e))
* **deps-dev:** bump the dev-dependencies group across 1 directory with 3 updates ([#31](https://github.com/funkadelic/claude-nomad/issues/31)) ([7edf58e](https://github.com/funkadelic/claude-nomad/commit/7edf58e5a7e9e6cece45bc3b5335383d3b582302))
* **deps-dev:** bump typescript from 5.9.3 to 6.0.3 ([#32](https://github.com/funkadelic/claude-nomad/issues/32)) ([97166f3](https://github.com/funkadelic/claude-nomad/commit/97166f30b364e7870b0d68358baa31de60bc1dcb))
* **deps:** bump github/codeql-action from 3 to 4 ([#30](https://github.com/funkadelic/claude-nomad/issues/30)) ([f9142e4](https://github.com/funkadelic/claude-nomad/commit/f9142e46dc49e2619139c306dac87ccd410c169d))
* skip workflows on private repos so user mirrors stay quiet ([#39](https://github.com/funkadelic/claude-nomad/issues/39)) ([635e46c](https://github.com/funkadelic/claude-nomad/commit/635e46c673c46146e3d052d009d166dc931b1c12))


### Dependencies

* **deps:** bump codecov/codecov-action from 6.0.0 to 6.0.1 ([#36](https://github.com/funkadelic/claude-nomad/issues/36)) ([bee25d9](https://github.com/funkadelic/claude-nomad/commit/bee25d9191de2dfc1c0460ec5a2e81bba46a405d))

## [0.8.0](https://github.com/funkadelic/claude-nomad/compare/v0.7.1...v0.8.0) (2026-05-18)


### Added

* **push-checks:** mirror install.sh gitleaks scaffold in runtime hint ([#26](https://github.com/funkadelic/claude-nomad/issues/26)) ([642d023](https://github.com/funkadelic/claude-nomad/commit/642d0235a1166b459f9ef973dd24016f8704d769))

## [0.7.1](https://github.com/funkadelic/claude-nomad/compare/v0.7.0...v0.7.1) (2026-05-18)


### Fixed

* **update:** absorb origin/main before merging upstream ([#24](https://github.com/funkadelic/claude-nomad/issues/24)) ([4d91679](https://github.com/funkadelic/claude-nomad/commit/4d916793e8a8036defc465dc271f42ed34ddb540))

## [0.7.0](https://github.com/funkadelic/claude-nomad/compare/v0.6.0...v0.7.0) (2026-05-18)


### Added

* **install:** add explicit gitleaks install commands and PATH detection ([#22](https://github.com/funkadelic/claude-nomad/issues/22)) ([1aaafff](https://github.com/funkadelic/claude-nomad/commit/1aaafffaf5b433feefb36eaaba84eeda75a56c53))

## [0.6.0](https://github.com/funkadelic/claude-nomad/compare/v0.5.1...v0.6.0) (2026-05-18)


### Added

* add `npm run update` for one-command CLI updates ([#20](https://github.com/funkadelic/claude-nomad/issues/20)) ([3ff7191](https://github.com/funkadelic/claude-nomad/commit/3ff7191c70af55c174a51313074358733bf10983))

## [0.5.1](https://github.com/funkadelic/claude-nomad/compare/v0.5.0...v0.5.1) (2026-05-18)


### Changed

* **install:** advise on gitleaks presence during setup ([#17](https://github.com/funkadelic/claude-nomad/issues/17)) ([4747440](https://github.com/funkadelic/claude-nomad/commit/4747440a610e53d311bf00e7106d4e1b1dc065fa))
* track src/nomad.ts as executable, drop chmod from install.sh ([#19](https://github.com/funkadelic/claude-nomad/issues/19)) ([a859893](https://github.com/funkadelic/claude-nomad/commit/a85989321336b5aaa55d1765906404ed95deccd8))

## [0.5.0](https://github.com/funkadelic/claude-nomad/compare/v0.4.0...v0.5.0) (2026-05-18)


### Added

* **push:** safe push pipeline + doctor push-readiness diagnostics ([#15](https://github.com/funkadelic/claude-nomad/issues/15)) ([c0b2c4a](https://github.com/funkadelic/claude-nomad/commit/c0b2c4a852a087eabe81297337b76e01647a460f))

## [0.4.0](https://github.com/funkadelic/claude-nomad/compare/v0.3.2...v0.4.0) (2026-05-17)


### Added

* add backup, lockfile, atomic write, and push allow-list to nomad ([#14](https://github.com/funkadelic/claude-nomad/issues/14)) ([95249e0](https://github.com/funkadelic/claude-nomad/commit/95249e0a658b96d2ce94989d91763f64c7cc8bc3))


### Fixed

* **links:** expect my-statusline.cjs since parent package is ESM ([#12](https://github.com/funkadelic/claude-nomad/issues/12)) ([a59d4d1](https://github.com/funkadelic/claude-nomad/commit/a59d4d1e23904cef9c6c65868f8f3e3ee9f86c1c))

## [0.3.2](https://github.com/funkadelic/claude-nomad/compare/v0.3.1...v0.3.2) (2026-05-16)


### Documentation

* **readme:** document NOMAD_HOST, TBD placeholder, migration flow, and cross-OS gotchas ([#10](https://github.com/funkadelic/claude-nomad/issues/10)) ([d95c4b1](https://github.com/funkadelic/claude-nomad/commit/d95c4b1c2665081d14c083723520f9bde8056b4c))

## [0.3.1](https://github.com/funkadelic/claude-nomad/compare/v0.3.0...v0.3.1) (2026-05-16)


### Fixed

* harden nomad push pipeline against drift and lint failures ([#8](https://github.com/funkadelic/claude-nomad/issues/8)) ([541399f](https://github.com/funkadelic/claude-nomad/commit/541399fc1e07540132ab50c778729dead054eed1))

## [0.3.0](https://github.com/funkadelic/claude-nomad/compare/v0.2.1...v0.3.0) (2026-05-15)


### Added

* NOMAD_HOST env override and recursive cpSync session sync ([#7](https://github.com/funkadelic/claude-nomad/issues/7)) ([1ab7a33](https://github.com/funkadelic/claude-nomad/commit/1ab7a332a5ff51b7ce73bca0785bb9d854dffb28))


### Changed

* **test:** wire up v8 coverage via npm run coverage ([#5](https://github.com/funkadelic/claude-nomad/issues/5)) ([a2be611](https://github.com/funkadelic/claude-nomad/commit/a2be611fbc7990e56ff14bd57ed5237db7c01c29))

## [0.2.1](https://github.com/funkadelic/claude-nomad/compare/v0.2.0...v0.2.1) (2026-05-15)


### Fixed

* **install:** mark install.sh executable ([#4](https://github.com/funkadelic/claude-nomad/issues/4)) ([4f38a0e](https://github.com/funkadelic/claude-nomad/commit/4f38a0e810e7d27fb6bc1b9df5899fe771a85754))


### Documentation

* clarify two-repo model and bootstrap flow in README ([#2](https://github.com/funkadelic/claude-nomad/issues/2)) ([944619f](https://github.com/funkadelic/claude-nomad/commit/944619f72c052fb53293ba2af59768667e9f332d))

## [0.2.0](https://github.com/funkadelic/claude-nomad/compare/v0.1.0...v0.2.0) (2026-05-14)


### Added

* initial CLI for syncing ~/.claude across hosts ([437fd5c](https://github.com/funkadelic/claude-nomad/commit/437fd5c4b3405cf3154c155b6bc15e8012c5ea38))


### Changed

* add husky hooks and commitlint config ([c5f1854](https://github.com/funkadelic/claude-nomad/commit/c5f1854d64ff6dd3c1aeb012d824cd6de3147c4c))
* add MIT license ([82f1a4d](https://github.com/funkadelic/claude-nomad/commit/82f1a4d7385bd2504818ed847e0a6ac51790fab9))
* add prettier and eslint configs ([d8f0dbc](https://github.com/funkadelic/claude-nomad/commit/d8f0dbc41b0fbec1a488479ced75b61fff7d27c7))
* **ci:** add release-please workflow ([8e58a71](https://github.com/funkadelic/claude-nomad/commit/8e58a71817744b0d98214deb8bb31f54d89e3843))
* **ci:** update release-please config ([911fed1](https://github.com/funkadelic/claude-nomad/commit/911fed12857a30305797d6f1e581b34e7f977f71))
