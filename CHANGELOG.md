# Changelog

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
