# Contributing to claude-nomad

Thanks for your interest in improving claude-nomad. It is a small TypeScript CLI, and the
contributor workflow is deliberately lightweight: clone, install, make a change behind the four
gates, and open a pull request. The machine-enforced configs (linked throughout) are the source of
truth, so this guide stays short and points at them rather than restating values that could drift.

## Table of contents

- [Development setup](#development-setup)
- [Dependency management](#dependency-management)
- [Branch naming](#branch-naming)
- [Commit messages](#commit-messages)
- [Pull requests](#pull-requests)
- [Releases](#releases)

## Development setup

Node is pinned via the `engines` field in [`package.json`](package.json); use that version or newer.

```bash
git clone git@github.com:funkadelic/claude-nomad.git
cd claude-nomad
npm ci
```

`npm ci` runs the `prepare` script, which initializes husky so the git hooks are active on a fresh
clone. Two hooks then fire automatically on `git commit`:

- [`.husky/pre-commit`](.husky/pre-commit) runs `lint-staged` (eslint and prettier on the staged
  files).
- [`.husky/commit-msg`](.husky/commit-msg) runs commitlint against the commit message.

Before opening a PR, run the four gates locally:

```bash
npm run format
npm run lint
npm run typecheck
npm run test
```

## Dependency management

The policy below is already encoded in the configs; this section records the reasoning so it does
not have to be reverse-engineered from them.

- **Ranges express intent, the lockfile guarantees installs.** Dependencies in
  [`package.json`](package.json) use caret (`^`) ranges to state compatibility intent, while the
  committed [`package-lock.json`](package-lock.json) is the single source of reproducible installs.
  CI and the documented setup use `npm ci`, which installs the locked tree exactly and fails if the
  lockfile and manifest disagree. Always commit the lockfile changes that an install produces.
- **Dependabot drives updates.** [`.github/dependabot.yml`](.github/dependabot.yml) opens weekly
  update PRs for both the `npm` and `github-actions` ecosystems, so bumps are reviewed rather than
  applied by hand. To keep the noise down it batches updates into grouped PRs and routes the commit
  prefixes (`deps` / `deps-dev`) through release-please so the bumps land under the changelog's
  Dependencies section.
- **`@types/node` majors are held back on purpose.** The config ignores `@types/node` major bumps so
  the type surface stays pinned to the lowest supported runtime. Letting it float would let a
  newer-Node-only API typecheck cleanly and then crash at runtime on the supported floor.
- **Hard pins are reserved for behavior-sensitive externals that are not npm range deps.** Two cases
  are pinned exactly rather than ranged: the gitleaks version, kept as a single
  `GITLEAKS_PINNED_VERSION` in [`src/config.ts`](src/config.ts) and mirrored in both workflow YAMLs,
  with [`src/config.gitleaks-pin.test.ts`](src/config.gitleaks-pin.test.ts) asserting the three stay
  in lockstep so a CI bump that misses the constant fails the suite; and first-party GitHub Actions,
  which are SHA-pinned for supply-chain integrity (Dependabot still proposes the bumps).
- **Do not exact-pin runtime dependencies in `package.json`.** claude-nomad is published to npm, so
  pinning a runtime dependency to an exact version blocks consumers from deduping it against their
  own tree and adds upgrade-PR churn that the committed lockfile already makes unnecessary. Pin in
  the lockfile (automatic), not in the manifest ranges.

One grouping choice is deliberate and worth stating: Dependabot groups dev-dependency `minor` and
`patch` updates and production `patch` updates into single PRs, but a production `minor` update
arrives as its own PR. Production minors are the likeliest to carry behavior change, so they get
individual review while the lower-risk batches stay consolidated.

## Branch naming

Branch off `main` with a `<type>/<slug>` name, where `<type>` is a Conventional Commit type (for
example `feat/path-remap-fix`, `fix/lockfile-race`, `docs/contributing`). Do not commit directly to
`main`.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
`<type>(optional scope): subject`, imperative mood, no trailing period. The enforced type list
(which extends the conventional set with `deps` and `deps-dev`) lives in
[`commitlint.config.js`](commitlint.config.js); that config, run by the commit-msg hook, is what
passes or fails your message. Keep the subject under about 72 characters. Bodies and footers are
free-form prose: the per-line length caps are disabled in the config, so write paragraphs as single
long lines and let the renderer soft-wrap.

## Pull requests

Keep PRs terse. The body is a short Summary, one or two bullets of what changed and why; GitHub
pre-fills [the template](.github/PULL_REQUEST_TEMPLATE.md). Do not add a test-plan checklist, do not
paste metrics that CI already reports, and do not include attribution trailers. The PR title must
itself be a valid Conventional Commit subject (a CI check enforces this).

## Releases

Releases are automated by release-please, which reads Conventional Commit types to decide both the
version bump and the changelog grouping:

- `feat` triggers a minor bump; `fix` and `perf` trigger a patch bump; a `!` suffix or a
  `BREAKING CHANGE:` footer triggers a major bump.
- Other types (`docs`, `refactor`, `test`, `build`, `ci`, `chore`, `style`, `deps`, `deps-dev`) are
  grouped into the changelog but do not by themselves bump the version. The full type-to-section
  mapping lives in [`release-please-config.json`](release-please-config.json).

Two per-PR escape hatches override the computed version when you need them: add a
`Release-As: <version>` footer to force a specific version, or wrap a replacement message in a
`BEGIN_COMMIT_OVERRIDE` / `END_COMMIT_OVERRIDE` block in the squashed PR body.
