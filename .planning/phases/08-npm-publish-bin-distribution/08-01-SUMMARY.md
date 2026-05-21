---
phase: 08-npm-publish-bin-distribution
plan: 01
subsystem: infra
tags: [npm, tsx, mit, package.json, prepublishOnly, NOMAD_REPO, oidc-publish]

requires:
  - phase: 04-bootstrap-recovery
    provides: doctor FATAL on missing ~/claude-nomad (constraint on --version probe independence)
  - phase: 06-polish-nomad-doctor-output-version-first-glyph-indicators
    provides: doctor section/glyph conventions (constraint on annotation placement)
provides:
  - publish-ready package.json (bin, description, keywords, repository, homepage, bugs, license, files)
  - tsx promoted to runtime dependency
  - NOMAD_REPO env override on REPO_HOME (mirrors NOMAD_HOST `||` empty-string-fallthrough)
  - nomad --version arm (bare semver, early dispatcher placement)
  - doctor (NOMAD_REPO) annotation on all three repo-state branches
  - LICENSE (canonical MIT, single-year copyright 2026)
  - scripts/verify-tarball.cjs (REQUIRED+FORBIDDEN whitelist verifier)
  - prepublishOnly chain (lint -> typecheck -> test -> verify-tarball)
affects: [08-02-ci-publish-workflow, 08-03-docs-readme-claudemd]

tech-stack:
  added:
    - LICENSE (MIT template at repo root)
    - scripts/verify-tarball.cjs (first .cjs file in the repo)
  patterns:
    - "Static JSON import via `import pkg from '../package.json' with { type: 'json' }` (Node 22+, NOT `assert`)"
    - "Early-arm `--version` dispatcher placement (before main command arms)"
    - "isOverrideActive() reads process.env.NOMAD_REPO directly so set-but-empty is distinguishable from default"
    - "ESLint flat-config CommonJS-files override (projectService:false + no-require-imports off)"

key-files:
  created:
    - LICENSE
    - scripts/verify-tarball.cjs
    - src/config.test.ts
    - src/package-json-shape.test.ts
    - .planning/phases/08-npm-publish-bin-distribution/08-01-SUMMARY.md
  modified:
    - package.json
    - src/config.ts
    - src/nomad.ts
    - src/commands.doctor.checks.ts
    - src/nomad.test.ts
    - src/commands.doctor.test.ts
    - eslint.config.js

key-decisions:
  - "Used `with { type: 'json' }` import attribute (typechecked clean under TS 6 + module:nodenext + erasableSyntaxOnly:true); no fallback to readFileSync needed"
  - "ESLint flat-config gained a `**/*.cjs` override to drop the typescript-eslint project service + the no-require-imports rule for .cjs files only (Rule 3 blocking fix)"
  - "prepublishOnly chains lint -> typecheck -> test -> verify-tarball (fail-fast: cheapest first, npm-pack hop last per RESEARCH §5 ordering)"
  - "files whitelist omits scripts/ per D-02; verify-tarball.cjs ships as a dev/CI tool, not a runtime artifact (and the verifier asserts it itself stays out of the tarball)"

patterns-established:
  - "Env-override with `||` empty-string fallthrough: `process.env.X || default` (mirrors NOMAD_HOST precedent, NOT `??`)"
  - "Doctor annotation pattern: helper `isOverrideActive()` reads env directly so set-but-empty is distinguishable from the resolved-default case; annotation appended on all three classifyRepoState branches"
  - "Tarball verifier shape: REQUIRED exact-list + REQUIRED pattern + FORBIDDEN regex; exits 1 with per-bucket diff message on drift"

requirements-completed:
  - "SPEC §1"
  - "SPEC §2"
  - "SPEC §3"
  - "SPEC §4"
  - "SPEC §5"
  - "SPEC §8"

duration: 12 min
completed: 2026-05-21
---

# Phase 8 Plan 01: Package Foundation Summary

**Publish-ready package.json + LICENSE, NOMAD_REPO env override on REPO_HOME, nomad --version arm, doctor annotation, and a tarball whitelist verifier wired into prepublishOnly.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-05-21T20:48:38Z (first task commit)
- **Completed:** 2026-05-21T21:00:01Z (third task commit)
- **Tasks:** 3
- **Files modified:** 7 (+ 4 created)

## Accomplishments

- Static JSON import via `with { type: 'json' }` typechecked cleanly on TS 6 + erasableSyntaxOnly; no readFileSync fallback needed.
- npm pack --dry-run lists 56 files; tarball composition asserts pass on a clean tree.
- LICENSE at repo root contains the canonical MIT template with `Copyright (c) 2026 Norman Yee`.
- All 11 Wave 0 test cases pass: 3 for NOMAD_REPO resolution, 2 for `--version` dispatcher, 2 for doctor annotation, 4 for package.json shape.
- src/nomad.ts grew from 207 to 227 lines (CLAUDE.md 200-line cap monitoring; Phase 16 will address per RESEARCH §Project Constraints).
- Four gates (format, lint, typecheck, test) green; 398/398 tests pass.

## Task Commits

1. **Task 1: Wave 0 RED, write failing tests** - `05e842c` (test)
2. **Task 2: NOMAD_REPO override, --version arm, doctor annotation, LICENSE, package.json shape** - `9be7fad` (feat)
3. **Task 3: verify-tarball.cjs + prepublishOnly wiring** - `b4dce90` (feat)

_Note: Plan was TDD-style; Task 1 is the RED commit, Tasks 2 and 3 are GREEN._

## Files Created/Modified

### Created

- `LICENSE` - Canonical MIT template, `Copyright (c) 2026 Norman Yee`, no extension, plain text.
- `scripts/verify-tarball.cjs` - CommonJS, shells out to `npm pack --dry-run --json`, asserts REQUIRED (LICENSE, README.md, CHANGELOG.md, package.json, shared/.gitignore, .gitleaks.toml, src/*.ts) and FORBIDDEN (`.planning`, `.github`, `tests`, `node_modules`, `scripts`, `hosts`, `install.sh`, `tsconfig.json`, `vitest.config.ts`); exit 1 on drift with per-bucket diff.
- `src/config.test.ts` - 3 cases under `REPO_HOME resolution` describe block (NOMAD_REPO set / empty / unset).
- `src/package-json-shape.test.ts` - 4 cases asserting publish-required fields, `bin.nomad` path, tsx-in-dependencies, prepublishOnly substring chain.

### Modified

- `package.json` - Added `description`, `keywords`, `repository` (git+https with .git suffix), `homepage`, `bugs`, `license`, `bin`, `files` (D-02 whitelist: `["src/", "shared/.gitignore", ".gitleaks.toml", "README.md", "CHANGELOG.md"]`), `prepublishOnly`. Moved tsx from `devDependencies` to `dependencies` (caret range preserved).
- `src/config.ts` - REPO_HOME now reads `process.env.NOMAD_REPO || resolve(HOME, 'claude-nomad')` with the `prefer-nullish-coalescing` eslint-disable and an updated JSDoc covering empty-string-fallthrough semantics.
- `src/nomad.ts` - Static JSON import added at the top using `with { type: 'json' }`; early-arm `case '--version':` placed BEFORE `case 'pull':` with `process.argv.length === 3` guard, prints bare semver to stdout, rejects extra argv with `usage: nomad --version` and exit 1.
- `src/commands.doctor.checks.ts` - New exported `isOverrideActive()` reads `process.env.NOMAD_REPO` directly; `reportRepoState` computes `overrideLabel = isOverrideActive() ? ' (NOMAD_REPO)' : ''` and appends it on all three branches (populated, partial, empty).
- `src/nomad.test.ts` - New `nomad.ts --version dispatcher` describe block adjacent to the existing `nomad.ts push dispatcher` block; 2 it-cases covering bare-semver output and extra-arg rejection.
- `src/commands.doctor.test.ts` - New `cmdDoctor NOMAD_REPO annotation` describe block adjacent to `cmdDoctor repo-state header`; 2 it-cases (annotation present when env set, absent when unset).
- `eslint.config.js` - New `**/*.cjs` override blocks: first drops `projectService` so the parser does not require a tsconfig entry; second spreads `disableTypeChecked` rules and explicitly turns off `@typescript-eslint/no-require-imports`.

## Decisions Made

- **Used `with { type: 'json' }` (not `assert`)** - Per Node 22+ requirements; typechecked cleanly with TS 6 + `module: nodenext` + `erasableSyntaxOnly: true`. RESEARCH A3 flagged this as Wave-0-testable; the fallback (readFileSync + fileURLToPath) was not needed.
- **prepublishOnly ordering: lint -> typecheck -> test -> verify-tarball** - Fail-fast (cheapest gate first, expensive `npm pack` hop last). RESEARCH §5 confirms this ordering.
- **Doctor annotation lives in `reportRepoState`, not `reportHostAndPaths`** - Per SPEC §5 acceptance criterion targeting; the empty-repo FAIL branch must also carry the annotation, and `reportRepoState` is the only branch-aware reporter.
- **Single-year copyright (2026 only, not a range)** - Per D-01 modern convention; matches peer Node CLIs (`tsx`, `husky`, `prettier`, `vitest`, `chezmoi` all single-year).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] ESLint refused to parse scripts/verify-tarball.cjs**
- **Found during:** Task 3 (verify-tarball.cjs creation)
- **Issue:** The repo's `eslint.config.js` enables `parserOptions.projectService: true` globally. typescript-eslint v8's project service requires every linted file to be in the tsconfig graph; `.cjs` files are not, producing `Parsing error: ... was not found by the project service`. Then `no-require-imports` (from the stylistic type-checked preset) blocked the require() syntax.
- **Fix:** Added two new flat-config blocks scoped to `**/*.cjs`: the first disables `projectService` for `.cjs` and switches `sourceType` to `commonjs`; the second spreads `tseslint.configs.disableTypeChecked.rules` and explicitly turns off `@typescript-eslint/no-require-imports`. Without both, lint fails on any future `.cjs` file. CommonJS extension is mandatory per PATTERNS.md because `package.json` has `"type": "module"`.
- **Files modified:** `eslint.config.js`
- **Verification:** `npm run lint` passes; the rule override is scoped to `**/*.cjs` only and does not affect any `.ts` file.
- **Committed in:** `b4dce90` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 blocking)
**Impact on plan:** Auto-fix scoped strictly to enable lint on the new `.cjs` extension. No scope creep; no production-source changes. PATTERNS.md flagged this as a risk-flag for the planner ("scripts/verify-tarball.cjs will be the first `.cjs` file in the repo. `lint-staged` already accepts the extension; no infra changes needed") but the eslint config required adjustment.

## Issues Encountered

- An earlier in-session navigation slip caused Edit/Write calls with main-repo absolute paths to contaminate the main repo's `src/commands.doctor.test.ts` and `src/nomad.test.ts` plus create stray `src/config.test.ts` and `src/package-json-shape.test.ts` files there. Reverted via `git -C <main> checkout --` for tracked files and `rm` for the strays. Worktree state is unaffected; all real work happened on the worktree branch. Per CLAUDE.md MEMORY.md `feedback_avoid_cd`, the takeaway is: Edit/Write paths must always be derived from the worktree root, not from any captured `pwd` of the orchestrator session.

## Verification Outcomes

- **Plan-level checks:**
  - `grep -A2 "process\.env\.NOMAD_REPO" src/config.ts` shows `||` (not `??`) and the `prefer-nullish-coalescing` eslint-disable line — pass.
  - `grep -c "overrideLabel" src/commands.doctor.checks.ts` returns 4 (1 declaration + 3 branch usages) — pass.
  - `--version` arm placed BEFORE `case 'pull':` per D-03 — confirmed at src/nomad.ts case order.
  - Tarball verifier negative-path smoke: with `scripts/` added to the `files` whitelist, the verifier exits 1 and lists `scripts/update.sh` + `scripts/verify-tarball.cjs` under `forbidden-present`.
  - Four gates: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test` all green.

- **Tarball composition (npm pack --dry-run):**
  - 56 files total in the published tarball.
  - Whitelisted directories/files all present (LICENSE auto-included by npm, no `files` entry required).
  - No surprises; no leakage of `.planning/`, `.github/`, `tests/`, `node_modules/`, or dev artifacts.

- **LICENSE copyright line:** `Copyright (c) 2026 Norman Yee` (verified via `grep -F`).

- **src/nomad.ts final line count:** 227 lines. CLAUDE.md cap is 200 — this is +27 over (was already +7 over before Phase 8). Phase 16 will address per RESEARCH §Project Constraints; no block here.

## Next Phase Readiness

- Package is mechanically publishable: a local `npm publish --access public` would now produce a valid tarball with the correct shape.
- Plan 02 (CI publish workflow) has a valid `package.json` to publish and a stable `nomad --version` smoke-test contract.
- Plan 03 (docs cleanup: README quickstart, CLAUDE.md NOMAD_REPO note, install.sh deletion) operates on already-shipped publish metadata.
- No blockers. No deferred items written to `deferred-items.md`.

## Self-Check: PASSED

- Files: LICENSE, scripts/verify-tarball.cjs, src/config.test.ts, src/package-json-shape.test.ts, SUMMARY.md all present in worktree.
- Commits: 05e842c (test), 9be7fad (feat), b4dce90 (feat) all reachable via `git log`.

---
*Phase: 08-npm-publish-bin-distribution*
*Completed: 2026-05-21*
