# Changelog

## [0.51.0](https://github.com/funkadelic/claude-nomad/compare/v0.50.3...v0.51.0) (2026-06-18)


### Added

* **capture-settings:** direction-aware settings drift detection and capture command ([#314](https://github.com/funkadelic/claude-nomad/issues/314)) ([512c1a2](https://github.com/funkadelic/claude-nomad/commit/512c1a27a3a573b3c2684bae21e577a50a58a098))


### Changed

* **deps:** regenerate package-lock.json ([#312](https://github.com/funkadelic/claude-nomad/issues/312)) ([a80a974](https://github.com/funkadelic/claude-nomad/commit/a80a9740be72a1cad6e7865697548274ff0fbe51))

## [0.50.3](https://github.com/funkadelic/claude-nomad/compare/v0.50.2...v0.50.3) (2026-06-17)


### Fixed

* **gitleaks:** scope tool-output noise allowlist to session transcripts ([#305](https://github.com/funkadelic/claude-nomad/issues/305)) ([ca76680](https://github.com/funkadelic/claude-nomad/commit/ca766803a425d21747f959606d6436989ce249e6))
* **push:** make --redact-all all-or-nothing ([#302](https://github.com/funkadelic/claude-nomad/issues/302)) ([f2cffeb](https://github.com/funkadelic/claude-nomad/commit/f2cffeb9204b68fb046ee55c9768e065272fb431))
* **push:** warn when drop-session/redact target is already in pushed history ([#304](https://github.com/funkadelic/claude-nomad/issues/304)) ([739676f](https://github.com/funkadelic/claude-nomad/commit/739676ffbf1345fc7ff124ac7eafb9802ba09be4))
* **redact:** warn when a finding match is not located in the file ([#310](https://github.com/funkadelic/claude-nomad/issues/310)) ([db1442b](https://github.com/funkadelic/claude-nomad/commit/db1442b311db04944b655ece91a56ef23a39abe1))
* **remap:** make session-transcript mirror copy atomic ([4fc518f](https://github.com/funkadelic/claude-nomad/commit/4fc518fd80ce7fffb56ba2a6d135e6f6b795bc91))
* **utils:** guard deepMerge against prototype pollution ([#299](https://github.com/funkadelic/claude-nomad/issues/299)) ([8e57539](https://github.com/funkadelic/claude-nomad/commit/8e575393a320386dd7329aab8071fd84557ec4e9))


### Changed

* **config:** centralize path-map.json shape validation ([#306](https://github.com/funkadelic/claude-nomad/issues/306)) ([88edda3](https://github.com/funkadelic/claude-nomad/commit/88edda3f45954d4dc89d65e2ec55a7d9d5b6b3f8))
* **dispatch:** share argv token-parser primitives ([#307](https://github.com/funkadelic/claude-nomad/issues/307)) ([9f62b51](https://github.com/funkadelic/claude-nomad/commit/9f62b5156bbc3b7e03f8a81fe0f844cbeb1da3fa))
* **doctor:** rename repository check module to git-state ([#309](https://github.com/funkadelic/claude-nomad/issues/309)) ([b6a0d5c](https://github.com/funkadelic/claude-nomad/commit/b6a0d5c8461c2f63af7d77464db9558271d46f46))
* **utils:** dedup backup helpers and document lock/exit conventions ([#308](https://github.com/funkadelic/claude-nomad/issues/308)) ([4c2d59d](https://github.com/funkadelic/claude-nomad/commit/4c2d59d97c875851733175e4b4346e5714c48a32))


### Documentation

* **recovery:** reflect session-scoped allowlist and redact no-match warning ([#311](https://github.com/funkadelic/claude-nomad/issues/311)) ([7faf564](https://github.com/funkadelic/claude-nomad/commit/7faf5647d7dfd30822950d687fd8be15b5c49910))


### Testing

* **push:** add full-pipeline cmdPush E2E against real git and gitleaks ([#303](https://github.com/funkadelic/claude-nomad/issues/303)) ([3c01262](https://github.com/funkadelic/claude-nomad/commit/3c012629e7b99dcf4c5e679d93acb353ee6c3409))

## [0.50.2](https://github.com/funkadelic/claude-nomad/compare/v0.50.1...v0.50.2) (2026-06-15)


### Fixed

* **push:** skip gsd-dropped hooks and agents from shared push ([#295](https://github.com/funkadelic/claude-nomad/issues/295)) ([b8f6665](https://github.com/funkadelic/claude-nomad/commit/b8f66658dd47dac40bfafd9899206a481d04a87a))


### Dependencies

* bump SonarSource/sonarqube-scan-action from 8.1.0 to 8.2.0 ([#297](https://github.com/funkadelic/claude-nomad/issues/297)) ([fdb681c](https://github.com/funkadelic/claude-nomad/commit/fdb681c4d346b9bd82b34fe6d9dee2d202186473))
* bump the dev-dependencies group with 5 updates ([#298](https://github.com/funkadelic/claude-nomad/issues/298)) ([0909a02](https://github.com/funkadelic/claude-nomad/commit/0909a025b698162c7a695354465046973ee93ab4))

## [0.50.1](https://github.com/funkadelic/claude-nomad/compare/v0.50.0...v0.50.1) (2026-06-12)


### Changed

* **doctor:** tidy summary verdict and dependency-version lines ([#289](https://github.com/funkadelic/claude-nomad/issues/289)) ([43d38a7](https://github.com/funkadelic/claude-nomad/commit/43d38a7bbf1780cd0e1e1b5e6bd85f9d75de7630))


### Documentation

* **hero:** plain-language status rows, drop gsd-owned files ([#291](https://github.com/funkadelic/claude-nomad/issues/291)) ([c144b0d](https://github.com/funkadelic/claude-nomad/commit/c144b0d01eea801d39b012ad3d4b3780d2ffafd1))
* **how-it-works:** use neutral sharedDirs example, not a gsd dir ([#292](https://github.com/funkadelic/claude-nomad/issues/292)) ([e000ecf](https://github.com/funkadelic/claude-nomad/commit/e000ecf67e814855d09c664b9dae6ce5d8287a97))
* **recipes:** add recipes page with example configs ([#293](https://github.com/funkadelic/claude-nomad/issues/293)) ([c339372](https://github.com/funkadelic/claude-nomad/commit/c3393723062bd9e639acff31e5236a9ff2ac2802))

## [0.50.0](https://github.com/funkadelic/claude-nomad/compare/v0.49.0...v0.50.0) (2026-06-11)


### Added

* **extras-sync:** overlay .planning sync so repo-only files survive ([#283](https://github.com/funkadelic/claude-nomad/issues/283)) ([8ba7e13](https://github.com/funkadelic/claude-nomad/commit/8ba7e1372a973b5d0434e7180595ddfaff2369e0))
* **pull:** self-heal unmerged-index wedge with no active rebase ([#286](https://github.com/funkadelic/claude-nomad/issues/286)) ([977534c](https://github.com/funkadelic/claude-nomad/commit/977534c56c6160e81a835189db21913424a20242))
* **sync:** stop double-managing gsd-owned hooks, agents, and skills ([#285](https://github.com/funkadelic/claude-nomad/issues/285)) ([aabfd8a](https://github.com/funkadelic/claude-nomad/commit/aabfd8a96ab80dc998b8df27d64f98ceaa33ec49))


### Documentation

* add GSD-aware sync page and document plugin minimum CLI version ([#287](https://github.com/funkadelic/claude-nomad/issues/287)) ([6ac4320](https://github.com/funkadelic/claude-nomad/commit/6ac4320dca12f959bd6329f0e1c813408a3b9c6a))
* **plugin:** clarify CLI-subcommand wording in version-floor note ([#288](https://github.com/funkadelic/claude-nomad/issues/288)) ([d45adee](https://github.com/funkadelic/claude-nomad/commit/d45adeed8d01515e6cb94f6ac72feced2fb31a52))

## [0.49.0](https://github.com/funkadelic/claude-nomad/compare/v0.48.0...v0.49.0) (2026-06-10)


### Added

* **plugin:** add companion Claude Code plugin ([#281](https://github.com/funkadelic/claude-nomad/issues/281)) ([af85994](https://github.com/funkadelic/claude-nomad/commit/af859940453b6f9419d26072be4b0e04aaea1e8f))

## [0.48.0](https://github.com/funkadelic/claude-nomad/compare/v0.47.1...v0.48.0) (2026-06-09)


### Added

* **push:** surface changed shared config in push output ([#278](https://github.com/funkadelic/claude-nomad/issues/278)) ([4774661](https://github.com/funkadelic/claude-nomad/commit/477466138e203f861e60c72cb6522f25393b3987))
* **update:** frame update output and report new version ([#279](https://github.com/funkadelic/claude-nomad/issues/279)) ([9342de1](https://github.com/funkadelic/claude-nomad/commit/9342de1187db1fd115cc73cb2b516a9477b67a54))

## [0.47.1](https://github.com/funkadelic/claude-nomad/compare/v0.47.0...v0.47.1) (2026-06-09)


### Fixed

* **extras:** preserve host-local deny-set files on .claude pull ([#276](https://github.com/funkadelic/claude-nomad/issues/276)) ([3742c3e](https://github.com/funkadelic/claude-nomad/commit/3742c3e4067c1c986e7f182011581d4c867847b0))

## [0.47.0](https://github.com/funkadelic/claude-nomad/compare/v0.46.0...v0.47.0) (2026-06-09)


### Added

* **extras:** add .claude as a supported per-project extra ([#274](https://github.com/funkadelic/claude-nomad/issues/274)) ([41a79a3](https://github.com/funkadelic/claude-nomad/commit/41a79a3fa9963f2ade76ec4d89d880d9634bb0d2))


### Changed

* remove orphaned shared/ folder from package ([#267](https://github.com/funkadelic/claude-nomad/issues/267)) ([93e4119](https://github.com/funkadelic/claude-nomad/commit/93e411951df4aa600e94da8d9db4298129ad1fa2))


### Documentation

* **extras:** document .claude extra in security, features, and recovery pages ([#275](https://github.com/funkadelic/claude-nomad/issues/275)) ([232016c](https://github.com/funkadelic/claude-nomad/commit/232016c5cb14988fb3fe8dd3f1f558d49789fffb))
* **faq:** explain unmapped local projects in nomad doctor ([#273](https://github.com/funkadelic/claude-nomad/issues/273)) ([6c2e9d4](https://github.com/funkadelic/claude-nomad/commit/6c2e9d475decb8cea3e159a3047f5f9daff24785))


### Dependencies

* bump @types/node in the dev-dependencies group ([#272](https://github.com/funkadelic/claude-nomad/issues/272)) ([951471e](https://github.com/funkadelic/claude-nomad/commit/951471e0879eee0e10756f67a9e58554dce96c52))
* bump actions/checkout from 6.0.2 to 6.0.3 ([#269](https://github.com/funkadelic/claude-nomad/issues/269)) ([21b7490](https://github.com/funkadelic/claude-nomad/commit/21b7490b273bfe22aa76216edc5de44a49b57c59))
* bump codecov/codecov-action from 6.0.1 to 7.0.0 ([#270](https://github.com/funkadelic/claude-nomad/issues/270)) ([905d468](https://github.com/funkadelic/claude-nomad/commit/905d46832e6d52c825419be39fac08d5408de39f))
* bump github/codeql-action from 4.36.0 to 4.36.2 ([#271](https://github.com/funkadelic/claude-nomad/issues/271)) ([6ff50c7](https://github.com/funkadelic/claude-nomad/commit/6ff50c76d3ddc9e0cd8247f572288b722cd588b5))

## [0.46.0](https://github.com/funkadelic/claude-nomad/compare/v0.45.0...v0.46.0) (2026-06-08)


### Added

* **doctor:** show a progress spinner while checks run ([#266](https://github.com/funkadelic/claude-nomad/issues/266)) ([148ee4d](https://github.com/funkadelic/claude-nomad/commit/148ee4dba75224a3d98059f48130c0bc4daab55f))
* **recovery:** show masked secret context in push recovery prompts ([#263](https://github.com/funkadelic/claude-nomad/issues/263)) ([d1de449](https://github.com/funkadelic/claude-nomad/commit/d1de449c183943a9e8efbadc354f20b7a6408c57))


### Fixed

* **links:** skip dry-run create event for already-correct symlinks ([#261](https://github.com/funkadelic/claude-nomad/issues/261)) ([4e32146](https://github.com/funkadelic/claude-nomad/commit/4e321463254d336786d4d7397ae0a0fdeb3274ae))


### Changed

* **summary:** drop glyph and "summary:" prefix from grouped-tree row ([#265](https://github.com/funkadelic/claude-nomad/issues/265)) ([5e87a18](https://github.com/funkadelic/claude-nomad/commit/5e87a183272ca3de27a80c0fd9e66089b11a4c64))


### Testing

* **recovery:** correct two inaccurate comments in recovery context tests ([#264](https://github.com/funkadelic/claude-nomad/issues/264)) ([371c43d](https://github.com/funkadelic/claude-nomad/commit/371c43dc6873b9c1d81ef477f535c47f47826e97))

## [0.45.0](https://github.com/funkadelic/claude-nomad/compare/v0.44.1...v0.45.0) (2026-06-07)


### Added

* **doctor:** warn when settings.json drifts from the base+host merge ([#259](https://github.com/funkadelic/claude-nomad/issues/259)) ([6401732](https://github.com/funkadelic/claude-nomad/commit/6401732199aa9f883de78b15b323ec4dfecf8d3f))


### Changed

* **gitleaks:** allowlist SSH key fingerprints in signature output ([#257](https://github.com/funkadelic/claude-nomad/issues/257)) ([ca310aa](https://github.com/funkadelic/claude-nomad/commit/ca310aa7f3a23b152ed149224400d60332ada037))


### Testing

* kill mutation survivors from the full Stryker sweep ([#260](https://github.com/funkadelic/claude-nomad/issues/260)) ([314e315](https://github.com/funkadelic/claude-nomad/commit/314e31587cb97e0fdf5b410587bb0ca64a2e46d5))

## [0.44.1](https://github.com/funkadelic/claude-nomad/compare/v0.44.0...v0.44.1) (2026-06-06)


### Fixed

* **config:** read HOME from process.env before os.homedir() ([#255](https://github.com/funkadelic/claude-nomad/issues/255)) ([2d5d679](https://github.com/funkadelic/claude-nomad/commit/2d5d67930196bd33f68de608385d4254f203f758))
* **output:** list per-item lines without info glyph ([#251](https://github.com/funkadelic/claude-nomad/issues/251)) ([bdbebee](https://github.com/funkadelic/claude-nomad/commit/bdbebee506d69eeffc91d609c44110f5d4f38e25))


### Changed

* **config:** resolve HOME-derived paths at call time ([#254](https://github.com/funkadelic/claude-nomad/issues/254)) ([db007fc](https://github.com/funkadelic/claude-nomad/commit/db007fceb92c435ad8c0149119691fdbdb6d9aaa))


### Documentation

* mark the HOME-isolation mutation-testing limitation resolved ([#256](https://github.com/funkadelic/claude-nomad/issues/256)) ([83f462d](https://github.com/funkadelic/claude-nomad/commit/83f462d51b991f3ecc7ce853c4694163fbb0b859))


### Testing

* add Stryker mutation-testing toolchain and prune zero-kill test ([#253](https://github.com/funkadelic/claude-nomad/issues/253)) ([c7339f1](https://github.com/funkadelic/claude-nomad/commit/c7339f11dd1dc28fa8fa73f744805dc0ca005855))

## [0.44.0](https://github.com/funkadelic/claude-nomad/compare/v0.43.0...v0.44.0) (2026-06-05)


### Added

* **eject:** add nomad eject offboarding command ([#250](https://github.com/funkadelic/claude-nomad/issues/250)) ([9b3c69f](https://github.com/funkadelic/claude-nomad/commit/9b3c69fb47dad561dee4beaed6ed55c172a0115a))


### Fixed

* **docs-site:** restore aside and GFM table rendering on .mdx pages ([#247](https://github.com/funkadelic/claude-nomad/issues/247)) ([5ccbb27](https://github.com/funkadelic/claude-nomad/commit/5ccbb27e294ccfccd46f842250a88673692894a3))


### Testing

* **pull:** freeze clock in freshStrandedBranch collision test ([#249](https://github.com/funkadelic/claude-nomad/issues/249)) ([e32b444](https://github.com/funkadelic/claude-nomad/commit/e32b444ceae38868d730fb45241cde6d04faf803))

## [0.43.0](https://github.com/funkadelic/claude-nomad/compare/v0.42.0...v0.43.0) (2026-06-05)


### Added

* **doctor:** summary verdict and output UX improvements ([#244](https://github.com/funkadelic/claude-nomad/issues/244)) ([46a8339](https://github.com/funkadelic/claude-nomad/commit/46a83394d1ff503db8dccb5a8b0ad59190da44cb))
* **doctor:** warn on hooks that break under symlinked dirs without --preserve-symlinks-main ([#246](https://github.com/funkadelic/claude-nomad/issues/246)) ([d9a4d20](https://github.com/funkadelic/claude-nomad/commit/d9a4d20b034920fe6fa4b1432d81fef361e6fbd2))


### Documentation

* add features overview to README and feature tour page to docs site ([#242](https://github.com/funkadelic/claude-nomad/issues/242)) ([e45d63f](https://github.com/funkadelic/claude-nomad/commit/e45d63f9d78aef5fa9a7a2b243584e96e1e17aaf))
* **faq:** add entry for symlink-broken relative requires in hooks ([#245](https://github.com/funkadelic/claude-nomad/issues/245)) ([fa994fb](https://github.com/funkadelic/claude-nomad/commit/fa994fb9ded981f419623dba3f50cc0cd812f986))

## [0.42.0](https://github.com/funkadelic/claude-nomad/compare/v0.41.0...v0.42.0) (2026-06-04)


### Added

* **pull:** add --force-remote recovery for wedged repos ([#241](https://github.com/funkadelic/claude-nomad/issues/241)) ([3425bc4](https://github.com/funkadelic/claude-nomad/commit/3425bc44e7a0c83335f5c170401619ff07ef0592))


### Fixed

* **preview:** drop /dev/null lines and key-order diff noise ([#237](https://github.com/funkadelic/claude-nomad/issues/237)) ([2a3271c](https://github.com/funkadelic/claude-nomad/commit/2a3271c637f467a07c64c4fd8c381dd042c10e9c))


### Documentation

* **faq:** add FAQ ([#240](https://github.com/funkadelic/claude-nomad/issues/240)) ([9150c97](https://github.com/funkadelic/claude-nomad/commit/9150c97a4f760dbb7ca3fd5a59657a3f34838aac))
* **faq:** add FAQ page with push-then-pull order of operations ([#239](https://github.com/funkadelic/claude-nomad/issues/239)) ([a0198ac](https://github.com/funkadelic/claude-nomad/commit/a0198ac1b77b87bbeef4f2dd3d11678ed58cb376))

## [0.41.0](https://github.com/funkadelic/claude-nomad/compare/v0.40.0...v0.41.0) (2026-06-03)


### Added

* **diff:** render diff and pull --dry-run as a glyph-free tree ([#236](https://github.com/funkadelic/claude-nomad/issues/236)) ([6cf1aff](https://github.com/funkadelic/claude-nomad/commit/6cf1aff60f7ac5710c990fb303c6408c0b07ff66))
* **spinner:** animate remap sync, fix stray frames ([#234](https://github.com/funkadelic/claude-nomad/issues/234)) ([5a71563](https://github.com/funkadelic/claude-nomad/commit/5a715637c8ab43ab2d536353f55512abe15cfdd3))

## [0.40.0](https://github.com/funkadelic/claude-nomad/compare/v0.39.0...v0.40.0) (2026-06-03)


### Added

* **spinner:** animate long-running operations ([#233](https://github.com/funkadelic/claude-nomad/issues/233)) ([e6755c3](https://github.com/funkadelic/claude-nomad/commit/e6755c3e5e86b52cbc5f996e9c5aee9d79da4574))


### Changed

* **docs-site:** build gate, link validation, and page metadata ([#231](https://github.com/funkadelic/claude-nomad/issues/231)) ([d4ad8ec](https://github.com/funkadelic/claude-nomad/commit/d4ad8ec0c414a91153a584156ccee2b32d824360))

## [0.39.0](https://github.com/funkadelic/claude-nomad/compare/v0.38.1...v0.39.0) (2026-06-02)


### Added

* **doctor:** group version checks into Nomad + Dependency sections ([#228](https://github.com/funkadelic/claude-nomad/issues/228)) ([08e8bf7](https://github.com/funkadelic/claude-nomad/commit/08e8bf79a730f1e7f025a1c2ad9dd406f586b05e))


### Documentation

* **how-it-works:** render repo-layout trees with FileTree ([#229](https://github.com/funkadelic/claude-nomad/issues/229)) ([b52de15](https://github.com/funkadelic/claude-nomad/commit/b52de152416ac5dabb650a1970b53a3b45262396))

## [0.38.1](https://github.com/funkadelic/claude-nomad/compare/v0.38.0...v0.38.1) (2026-06-02)


### Fixed

* **docs:** base-qualify internal links so they resolve under /claude-nomad ([#222](https://github.com/funkadelic/claude-nomad/issues/222)) ([8cff369](https://github.com/funkadelic/claude-nomad/commit/8cff3691687d07eb4c0f54f9f7fdbf680342c2e4))


### Changed

* adopt fallow analyzer config ([#227](https://github.com/funkadelic/claude-nomad/issues/227)) ([ebf7ca0](https://github.com/funkadelic/claude-nomad/commit/ebf7ca0aa05510fa9edde5f408e951b7bfec05ab))
* break import cycles and trim unused exports ([#225](https://github.com/funkadelic/claude-nomad/issues/225)) ([1808539](https://github.com/funkadelic/claude-nomad/commit/180853964c1d09153b3c9e1272255e2a753bd6d3))
* **tests:** don't cancel in-progress push:main coverage runs ([#226](https://github.com/funkadelic/claude-nomad/issues/226)) ([3164283](https://github.com/funkadelic/claude-nomad/commit/31642839a5be85e3e9a966411bf5b839226616e8))


### Documentation

* document ALWAYS_NEVER_SYNC credential hard-block in docs-site ([#224](https://github.com/funkadelic/claude-nomad/issues/224)) ([8904a4a](https://github.com/funkadelic/claude-nomad/commit/8904a4a8685f555e399dd394b825018e2055d373))

## [0.38.0](https://github.com/funkadelic/claude-nomad/compare/v0.37.0...v0.38.0) (2026-06-02)


### Added

* non-interactive gitleaks allowlist (nomad allow, push --allow/--allow-all) ([#220](https://github.com/funkadelic/claude-nomad/issues/220)) ([c6cc5eb](https://github.com/funkadelic/claude-nomad/commit/c6cc5ebec5dd15cd1aba74dd3627d18c39c8b8c4))

## [0.37.0](https://github.com/funkadelic/claude-nomad/compare/v0.36.0...v0.37.0) (2026-06-02)


### Added

* **docs:** create documentation site  ([#216](https://github.com/funkadelic/claude-nomad/issues/216)) ([6b9a2b0](https://github.com/funkadelic/claude-nomad/commit/6b9a2b0ae8658f6770aaeb779da1b8d8c18bf18c))


### Fixed

* **docs:** base-qualify landing page hero links ([#217](https://github.com/funkadelic/claude-nomad/issues/217)) ([67f279c](https://github.com/funkadelic/claude-nomad/commit/67f279cf66073986a5d51192403fa568e10cdd00))
* **push:** close gitleaks leak-recovery coverage gaps ([#218](https://github.com/funkadelic/claude-nomad/issues/218)) ([2e6b53c](https://github.com/funkadelic/claude-nomad/commit/2e6b53c86ce0d76c88da7d7d8ad8f33a2fed4c37))


### Changed

* **deps-dev:** bump the dev-dependencies group with 7 updates ([#214](https://github.com/funkadelic/claude-nomad/issues/214)) ([41c48d1](https://github.com/funkadelic/claude-nomad/commit/41c48d1e74ff02377046cdb8e7b165a762e1c242))


### Documentation

* docs-site accuracy, theming, and fork-era terminology cleanup ([#219](https://github.com/funkadelic/claude-nomad/issues/219)) ([a50c9a4](https://github.com/funkadelic/claude-nomad/commit/a50c9a4c2e2c7df268eef25421c506d8f5da1681))

## [0.36.0](https://github.com/funkadelic/claude-nomad/compare/v0.35.0...v0.36.0) (2026-06-01)


### Added

* **doctor:** require an HTTP fetcher (curl or wget) for the version check ([#210](https://github.com/funkadelic/claude-nomad/issues/210)) ([96b5a53](https://github.com/funkadelic/claude-nomad/commit/96b5a532e688cca9acebb1c6780d4106b2f21f5b))


### Changed

* **backup:** route backup-path writers through BACKUP_BASE ([#211](https://github.com/funkadelic/claude-nomad/issues/211)) ([7033c29](https://github.com/funkadelic/claude-nomad/commit/7033c29c9af76db029f44d0f1717ea1831ba122e))
* **tests:** label the test matrix jobs with the Node version ([#208](https://github.com/funkadelic/claude-nomad/issues/208)) ([3ada7e1](https://github.com/funkadelic/claude-nomad/commit/3ada7e12f38fc43f517842435b46c967c9312b25))


### Documentation

* **hero:** add hooks/, align glyph + terminal, tighten spacing ([#213](https://github.com/funkadelic/claude-nomad/issues/213)) ([d0bf93f](https://github.com/funkadelic/claude-nomad/commit/d0bf93f93fb21f65b8c5893b70bacbbf05d8ebe6))
* refresh contributor and user docs for recent changes ([#212](https://github.com/funkadelic/claude-nomad/issues/212)) ([d909097](https://github.com/funkadelic/claude-nomad/commit/d9090977fdf445316128ca9a0fefdec966105b58))

## [0.35.0](https://github.com/funkadelic/claude-nomad/compare/v0.34.1...v0.35.0) (2026-05-31)


### Added

* **clean:** prune old backups via nomad clean --backups ([#207](https://github.com/funkadelic/claude-nomad/issues/207)) ([ed9149d](https://github.com/funkadelic/claude-nomad/commit/ed9149d549fa87122238ddc7deb3c402555f62a6))
* **doctor:** warn on ESM/CommonJS hook module-scope mismatch ([#206](https://github.com/funkadelic/claude-nomad/issues/206)) ([451a3c3](https://github.com/funkadelic/claude-nomad/commit/451a3c380bb4fc0cb6d6bf6fc2e51c69ca20c159))


### Changed

* remove dead code left by recent refactors ([#204](https://github.com/funkadelic/claude-nomad/issues/204)) ([c956f29](https://github.com/funkadelic/claude-nomad/commit/c956f291653141512ddc96fbca66d9512dab1377))

## [0.34.1](https://github.com/funkadelic/claude-nomad/compare/v0.34.0...v0.34.1) (2026-05-31)


### Fixed

* **dist:** bundle bin to dist/nomad.mjs so global install works ([#202](https://github.com/funkadelic/claude-nomad/issues/202)) ([146813b](https://github.com/funkadelic/claude-nomad/commit/146813b16e67f8168fa4550b40db4ac6dc3238ec))

## [0.34.0](https://github.com/funkadelic/claude-nomad/compare/v0.33.0...v0.34.0) (2026-05-31)


### ⚠ BREAKING CHANGES

* `nomad update` no longer self-updates via git/fork (it runs only `npm update -g claude-nomad`) and the `--push-origin` flag is removed. `nomad init` now requires the GitHub CLI (`gh`) on first-host setup when REPO_HOME has no `origin` remote.

### Added

* **push:** gitleaks allowlist base+overlay merge ([#201](https://github.com/funkadelic/claude-nomad/issues/201)) ([f6f2e8c](https://github.com/funkadelic/claude-nomad/commit/f6f2e8c62ef868b33f560170ddd8c60122eac4cb))
* standalone-repo onboarding as the default, retire fork model ([#199](https://github.com/funkadelic/claude-nomad/issues/199)) ([8d38df9](https://github.com/funkadelic/claude-nomad/commit/8d38df909c36eeda085f8d4eb78e706c4ad2f115))

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
