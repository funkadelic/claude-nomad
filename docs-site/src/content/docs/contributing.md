---
title: Contributing
description: How to contribute to claude-nomad.
---

Thanks for your interest in improving claude-nomad. It is a small TypeScript CLI, and the
contributor workflow is deliberately lightweight: clone, install, make a change behind the five
gates, and open a pull request. The machine-enforced configs (linked throughout) are the source of
truth, so this guide stays short and points at them rather than restating values that could drift.

## Development setup

Node is pinned via the `engines` field in [`package.json`](https://github.com/funkadelic/claude-nomad/blob/main/package.json);
use that version or newer.

```bash
git clone git@github.com:funkadelic/claude-nomad.git
cd claude-nomad
npm ci
```

`npm ci` runs the `prepare` script, which initializes husky so the git hooks are active on a fresh
clone. Two hooks then fire automatically on `git commit`:

- `.husky/pre-commit` runs `lint-staged`: eslint and prettier on staged `*.ts`, markdownlint and
  prettier on staged `*.md`, and prettier on staged JSON/JS.
- `.husky/commit-msg` runs commitlint against the commit message.

Before opening a PR, run the five gates locally:

```bash
npm run format
npm run lint
npm run typecheck
npm run test
npm run lint:md
```

## Dependency management

The policy below is already encoded in the configs; this section records the reasoning so it does
not have to be reverse-engineered from them.

- **Ranges express intent, the lockfile guarantees installs.** Dependencies in `package.json` use
  caret (`^`) ranges to state compatibility intent, while the committed `package-lock.json` is the
  single source of reproducible installs. CI and the documented setup use `npm ci`, which installs
  the locked tree exactly and fails if the lockfile and manifest disagree. Always commit the
  lockfile changes that an install produces.
- **Dependabot drives updates.** `.github/dependabot.yml` opens weekly update PRs for both the
  `npm` and `github-actions` ecosystems, so bumps are reviewed rather than applied by hand. To
  keep the noise down it batches updates into grouped PRs and routes the commit prefixes (`deps` /
  `deps-dev`) through release-please so the bumps land under the changelog's Dependencies section.
- **`@types/node` majors are held back on purpose.** The config ignores `@types/node` major bumps
  so the type surface stays pinned to the lowest supported runtime. Letting it float would let a
  newer-Node-only API typecheck cleanly and then crash at runtime on the supported floor.
- **Hard pins are reserved for behavior-sensitive externals that are not npm range deps.** Two
  cases are pinned exactly rather than ranged: the gitleaks version, kept as a single
  `GITLEAKS_PINNED_VERSION` in `src/config.ts` and mirrored in both workflow YAMLs, with
  `src/config.gitleaks-pin.test.ts` asserting the three stay in lockstep so a CI bump that misses
  the constant fails the suite; and first-party GitHub Actions, which are SHA-pinned for
  supply-chain integrity (Dependabot still proposes the bumps).
- **Do not exact-pin runtime dependencies in `package.json`.** claude-nomad is published to npm,
  so pinning a runtime dependency to an exact version blocks consumers from deduping it against
  their own tree and adds upgrade-PR churn that the committed lockfile already makes unnecessary.
  Pin in the lockfile (automatic), not in the manifest ranges.

One grouping choice is deliberate and worth stating: Dependabot groups dev-dependency `minor` and
`patch` updates and production `patch` updates into single PRs, but a production `minor` update
arrives as its own PR. Production minors are the likeliest to carry behavior change, so they get
individual review while the lower-risk batches stay consolidated.

## Mutation testing

Stryker flags tests that kill zero mutants across a module's mutation report. A zero-kill test is
one that no code change in that module could cause to fail; it is a candidate for removal if it is
redundant with a richer sibling. Use this workflow to identify and triage those candidates.

**Mutation testing is local-only.** Runtime is 20 to 60 minutes for a full sweep, so it is never
wired into CI. Run it as a hygiene exercise, not as part of the normal development loop.

### Running per-module

The committed
[`stryker.config.mjs`](https://github.com/funkadelic/claude-nomad/blob/main/stryker.config.mjs)
contains the project defaults. Run one module at a time, always scoping both the mutate target and
the test files:

```bash
npx stryker run --incremental --force \
  --mutate "src/<module>.ts" \
  --testFiles "src/<module>.test.ts"
```

The `--testFiles` scope is required. Without it Stryker runs the full suite as the dry-run baseline
and the dry run fails on developer machines (the full suite is not idempotent under the Stryker
sandbox).

Reports land in `reports/mutation/` (gitignored). Archive each module's
`reports/mutation/mutation.json` under a per-module name (for example
`reports/archive/<module>.json`) before moving to the next module, or the file will be overwritten.
The `reports/stryker-incremental.json` incremental cache accumulates across sessions so you can
resume a multi-session sweep without re-running completed modules.

### Known limitation: HOME-based test isolation

Modules whose tests set `process.env.HOME = <tmpDir>` and call `vi.resetModules()` to reload
[`src/config.ts`](https://github.com/funkadelic/claude-nomad/blob/main/src/config.ts) cannot
currently be mutation-tested. That module resolves `REPO_HOME` at module load time via
`os.homedir()`, and Stryker's sandbox pins that resolution at process start. The re-imported module
sees the sandbox HOME, not the test HOME, so the dry-run baseline fails before any mutation runs.

Modules that use a `NOMAD_REPO` environment override instead of HOME (or that do not mutate HOME at
all) are not affected and can be swept normally. This limitation does not reduce test coverage;
those modules remain fully exercised by the normal `npm test` run.

### Triage

After running a module, list zero-kill candidates:

```bash
node scripts/find-zero-kill-tests.mjs reports/archive/<module>.json
```

[`scripts/find-zero-kill-tests.mjs`](https://github.com/funkadelic/claude-nomad/blob/main/scripts/find-zero-kill-tests.mjs)
emits one `ZERO-KILL` line per candidate and exits 0 (no output means every test in the report
kills at least one mutant).

Review each candidate against the keep/delete criterion:

- **Delete** only when the test is redundant with a richer sibling in the same file, a literal
  duplicate, or a narrow early test that is fully subsumed by a later broader test.
- **Keep** when the test pins a distinct documented behavior (for example, a specific error path or
  an empty-input contract), guards a branch that Stryker does not mutate, or is the sole
  documentation of a behavioral contract.

Zero-kill results from subprocess-based tests (for example, `commands.adopt`) are expected false
positives: Stryker cannot observe kills that happen inside a spawned child process. Keep those
tests without further analysis.

**Security modules default to keep.** Tests in `src/push-checks.ts`, `src/push-gitleaks*.ts`,
`src/commands.redact*.ts`, `src/commands.push.recovery*.ts`, `src/utils.lockfile*.ts`, and
`src/config.sharedDirs.guard.ts` are never bulk-deleted. A zero-kill result in a security module
often documents a refusal or containment invariant that mutation testing does not exercise (for
example, a traversal-guard rejection path). Delete a security-module test only with an explicit
recorded rationale.

### Coverage guardrail

After each deletion, run:

```bash
npm run coverage
```

If the deletion uncovers lines in the touched source file, revert it. The test was load-bearing for
coverage, not dead weight. The project coverage gate must not regress: a fully-covered file is
absent from the coverage text table (`skipFull`), so absence is the pass signal.

## Branch naming

Branch off `main` with a `<type>/<slug>` name, where `<type>` is a Conventional Commit type (for
example `feat/path-remap-fix`, `fix/lockfile-race`, `docs/contributing`). Do not commit directly
to `main`.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
`<type>(optional scope): subject`, imperative mood, no trailing period. The enforced type list
(which extends the conventional set with `deps` and `deps-dev`) lives in `commitlint.config.js`;
that config, run by the commit-msg hook, is what passes or fails your message. Keep the subject
under about 72 characters. Bodies and footers are free-form prose: the per-line length caps are
disabled in the config, so write paragraphs as single long lines and let the renderer soft-wrap.

## Pull requests

Keep PRs terse. The body is a short Summary, one or two bullets of what changed and why; GitHub
pre-fills the template. Do not add a test-plan checklist, do not paste metrics that CI already
reports, and do not include attribution trailers. The PR title must itself be a valid Conventional
Commit subject (a CI check enforces this).

## Releases

Releases are automated by release-please, which reads Conventional Commit types to decide both
the version bump and the changelog grouping:

- `feat` triggers a minor bump; `fix` and `perf` trigger a patch bump; a `!` suffix or a
  `BREAKING CHANGE:` footer triggers a major bump.
- Other types (`docs`, `refactor`, `test`, `build`, `ci`, `chore`, `style`, `deps`, `deps-dev`)
  are grouped into the changelog but do not by themselves bump the version. The full
  type-to-section mapping lives in `release-please-config.json`.

Two per-PR escape hatches override the computed version when you need them: add a
`Release-As: <version>` footer to force a specific version, or wrap a replacement message in a
`BEGIN_COMMIT_OVERRIDE` / `END_COMMIT_OVERRIDE` block in the squashed PR body.
