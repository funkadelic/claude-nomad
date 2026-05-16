# Changelog

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
