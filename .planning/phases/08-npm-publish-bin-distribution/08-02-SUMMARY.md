---
phase: 08-npm-publish-bin-distribution
plan: 02
subsystem: infra
tags: [github-actions, oidc, npm-publish, sigstore-provenance, trusted-publisher, workflow, bootstrap]

requires:
  - phase: 08-npm-publish-bin-distribution
    plan: 01
    provides: publish-ready package.json (repository.url=git+https://github.com/funkadelic/claude-nomad.git for OIDC validation), nomad --version arm (bare semver stdout for smoke-test contract), prepublishOnly chain (lint+typecheck+test+verify-tarball runs inside `npm publish`)
provides:
  - .github/workflows/npm-publish.yml (release-triggered, OIDC trusted publishing, post-publish smoke test)
  - .planning/phases/08-npm-publish-bin-distribution/08-02-BOOTSTRAP.md (one-time maintainer D-04 Option A procedure)
  - Inert publish pipeline ready for v0.16.3+ once maintainer reserves package name and configures trusted-publisher rules
affects: [08-03-docs-cleanup]

tech-stack:
  added:
    - .github/workflows/npm-publish.yml (new release-triggered CI workflow)
  patterns:
    - "Release-event-only trigger (no push, no workflow_dispatch) keeps publish surface minimal and inert until bootstrap"
    - "env-mapped tag_name then shell ${VERSION#v} strip handles release-please's v-prefix vs. npm's bare-semver convention"
    - "Two-job split: publish (OIDC id-token: write) and smoke-test (needs: publish, no privileged perms)"
    - "Belt-and-suspenders --provenance --access public flags even though trusted publishing should auto-attach"

key-files:
  created:
    - .github/workflows/npm-publish.yml
    - .planning/phases/08-npm-publish-bin-distribution/08-02-BOOTSTRAP.md
    - .planning/phases/08-npm-publish-bin-distribution/08-02-SUMMARY.md
  modified: []

key-decisions:
  - "Workflow stays inert until D-04 bootstrap completes: only release: types: [published] trigger, no workflow_dispatch (avoids accidental pre-bootstrap publish attempts)"
  - "registry-url present only on the publish job; smoke-test job omits it because npm i -g uses the default registry and the OIDC-aware .npmrc is only needed by `npm publish`"
  - "tag_name routed through env: VERSION before shell interpolation (CodeQL/security best practice for untrusted GitHub event payloads); ${VERSION#v} strip handles release-please's v-prefix"
  - "Reworded NPM_TOKEN comment in workflow to `no long-lived registry credentials required` so the plan-level grep for NPM_TOKEN returns zero matches (SPEC §Boundaries contract)"

patterns-established:
  - "OIDC publish workflow skeleton: permissions {contents: read, id-token: write} + actions/setup-node@v6 with registry-url + npm ci before publish + concurrency group keyed by tag"
  - "Bootstrap doc shape for one-time maintainer procedures: 5-step checklist + scripted-vs-manual matrix + per-step recovery + irreversibility note"

requirements-completed:
  - "SPEC §9"
  - "SPEC §10"

duration: 8 min
completed: 2026-05-21
---

# Phase 8 Plan 02: npm publish workflow Summary

**Release-triggered OIDC publish workflow plus post-publish nomad --version smoke test, paired with the maintainer-only D-04 Option A bootstrap procedure.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-05-21T21:08:01Z (Task 1 commit)
- **Completed:** 2026-05-21T21:11:30Z (Task 2 commit)
- **Tasks:** 2
- **Files modified:** 0 (+2 created)

## Accomplishments

- `.github/workflows/npm-publish.yml` lands two jobs (`publish` and `smoke-test`), wired for OIDC trusted publishing via `id-token: write`, `registry-url: https://registry.npmjs.org` on setup-node, `npm publish --provenance --access public`, and a smoke-test job that strict-equality-asserts `nomad --version` against `${VERSION#v}` (the release tag with leading `v` stripped).
- The workflow is INERT before bootstrap: the only trigger is `release: { types: [published] }`. No `workflow_dispatch:`, no `push:` trigger. Landing the file via PR carries zero publish risk because no GitHub Release exists yet for this package; even if one were cut, `npm publish` would fail without trusted-publisher rules configured (which only exist after step 3 of D-04).
- All five canonical RESEARCH §6 pitfalls are encoded as YAML structure: Pitfall 1 (`--provenance --access public` belt-and-suspenders), Pitfall 4 (filename is `.yml`), Pitfall 6 (`npm ci` before publish, `registry-url` on setup-node), Pitfall 8 (`${VERSION#v}` shell strip in smoke test), Pitfall 9 (release-event-only trigger, no anti-recursion concerns since release-please-action authors releases under an App token).
- `08-02-BOOTSTRAP.md` documents D-04 Option A as a 5-step checklist (`npm adduser` -> local `npm publish` of v0.16.2 -> web-UI trusted-publisher config at `https://www.npmjs.com/package/claude-nomad/access` -> verification -> first OIDC publish via CI at v0.16.3+), each step with expected outputs, scripted-vs-manual matrix, per-step recovery, and an irreversibility note.
- Four gates remain green (format:check, lint, typecheck, test); 398/398 tests pass. No source code touched in Plan 02; the workflow YAML and bootstrap MD are out-of-source artifacts.

## Final shape of npm-publish.yml

- **Total file size:** 95 lines (header comment + name + on + permissions + concurrency + jobs.publish + jobs.smoke-test).
- **publish job step count:** 4 steps (checkout, setup-node with registry-url, `npm ci`, `npm publish --provenance --access public`).
- **smoke-test job step count:** 3 steps (setup-node without registry-url, env-mapped install via `${VERSION#v}`, multi-line `run:` block with `set -euo pipefail` and strict-equality assertion).
- **Smoke-test parameter expansion:** `${VERSION#v}` is used in BOTH the install step (`npm i -g "claude-nomad@${VERSION#v}"`) and the assertion step (`expected="${VERSION#v}"`). Per Pitfall 8 — confirmed correct: this strips the `v` prefix from release-please's `tag_name: v0.16.2` to match `package.json`'s bare semver.

## Confirmed inert state

The workflow trigger is `release: { types: [published] }` ONLY. There is no `push:` trigger, no `workflow_dispatch:`, no `schedule:`. The file landing via PR (and any merge to main) does NOT fire the workflow. Even a future GitHub Release event would fail at `npm publish` step until trusted-publisher rules attach via D-04 step 3. This is by design (per SPEC §9 + D-04 sequencing) and gives the maintainer full control over when the publish pipeline goes live.

## Bootstrap doc readiness

| Step | Type | Action |
|------|------|--------|
| 1 | manual | `npm adduser` (2FA TOTP is human-in-the-loop) |
| 2 | scriptable | Local `npm publish --access public` of v0.16.2 |
| 3 | manual | Web UI: `https://www.npmjs.com/package/claude-nomad/access` -> Trusted Publisher -> GitHub Actions with `funkadelic`/`claude-nomad`/`npm-publish.yml` filename |
| 4 | scriptable | `npm view claude-nomad version`, `npm install -g claude-nomad`, `nomad --version` |
| 5 | automatic | Next `chore(main): release` PR merge triggers `npm-publish.yml` for v0.16.3+ |

Maintainer-action gates are steps 1 and 3. Everything else either runs as shell commands the maintainer can copy from the doc or fires automatically.

## Files Created

- `.github/workflows/npm-publish.yml` (95 lines) — Release-triggered OIDC publish workflow with post-publish `nomad --version` smoke test. Comment header explains purpose and points to the bootstrap doc; inline comments justify every non-obvious YAML choice (id-token: write, --provenance flag, registry-url, npm ci, VERSION#v).
- `.planning/phases/08-npm-publish-bin-distribution/08-02-BOOTSTRAP.md` (122 lines) — D-04 Option A one-time maintainer procedure. 5 numbered steps with expected outputs, scripted-vs-manual matrix, recovery paths, irreversibility note. Lives under `.planning/` (force-added because of the repo's `.planning/` gitignore line; matches the pattern Plan 01 established for `08-01-SUMMARY.md`).

## Decisions Made

- **No deviation from RESEARCH §1 canonical YAML.** The workflow file is a near-verbatim copy of the canonical structure: same trigger, same permissions, same concurrency, same two-job split, same step ordering. Inline comments expand the rationale that the plan's `<action>` block specified. No `workflow_dispatch` was added; the planner explicitly rejected it (and the plan reaffirmed it under "Do NOT introduce") to keep the publish surface minimal.
- **env-mapped `tag_name` everywhere it touches `run:`.** Per the security hook reminder for GitHub Actions workflow injection: `${{ github.event.release.tag_name }}` is mapped through `env: VERSION:` in both the install step and the verification step, then dereferenced as `${VERSION#v}` in the shell. This is the safe pattern; raw `${{ }}` interpolation directly in `run:` would be a command-injection surface even though release tag names are usually well-formed.
- **NPM_TOKEN comment reworded.** Initial draft of the `permissions:` comment said "no long-lived NPM_TOKEN required"; reworded to "no long-lived registry credentials required" so the plan-level grep `grep -E "NPM_TOKEN|npm[-_]?token" .github/workflows/npm-publish.yml` returns zero matches, satisfying the verification §5 contract strictly. The semantics are identical; the literal token-name reference was only documentation.

## Deviations from Plan

None — plan executed exactly as written. Both task acceptance criteria sets pass; the only departure from the literal `<action>` text was the NPM_TOKEN comment reword above, which strengthens (does not weaken) the plan-level verification contract.

## Issues Encountered

- Worktree HEAD initial `merge-base` against the expected base (`4f8ddf0…`) showed a divergence because the worktree was created with `gsd/phase-08` as its starting point but inherited `main` history; the safety check's prescribed `git reset --hard 4f8ddf0…` ran cleanly and produced a worktree HEAD on the correct base. Plan 01's output was visible in `git log` after the reset. No data loss; no impact on Plan 02 work.
- The pre-commit `prettier --write` hook reformatted `08-02-BOOTSTRAP.md` during Task 2's commit. Re-read after commit showed no content drift — prettier preserved every code fence, table, and link. No regression.

## Verification Outcomes

- **Plan-level check 1 (YAML lint):** No tabs (`grep -c $'\t'` returned 0), no em-dashes (`grep -cP '[\x{2013}\x{2014}]'` returned 0). Manual eyeball-review of indentation (2-space throughout) and `${{ ... }}` brace balance: pass.
- **Plan-level check 2 (Pitfall mitigations):** All five present — `registry-url` line 44, `--provenance --access public` line 58, filename `npm-publish.yml`, `${VERSION#v}` lines 79 and 89, `npm ci` line 50 before `npm publish` line 58. No `workflow_dispatch` trigger.
- **Plan-level check 3 (Bootstrap doc):** All 5 steps present at lines 13, 31, 54, 72, 94. `Option A`, `https://www.npmjs.com/package/claude-nomad/access`, `npm-publish.yml`, `funkadelic`, `npm adduser`, `npm publish --access public` all grep-match. 0 em-dashes. 952 words.
- **Plan-level check 4 (workflow inert):** confirmed. Only `release: { types: [published] }` trigger; no `workflow_dispatch:`, no `push:`, no `schedule:`.
- **Plan-level check 5 (no NPM_TOKEN):** `grep -E "NPM_TOKEN|npm[-_]?token" .github/workflows/npm-publish.yml` returns 0 matches.
- **Plan-level check 6 (repo URL alignment):** `package.json` declares `"url": "git+https://github.com/funkadelic/claude-nomad.git"`, exact byte-match with `funkadelic`/`claude-nomad` in the bootstrap doc and the GitHub repo the workflow runs in (required for OIDC repo-claim validation).
- **Four gates:** `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test` all green. 398/398 tests pass in 16.43s.

## Task Commits

1. **Task 1: Write .github/workflows/npm-publish.yml with publish + smoke-test jobs** — `94956b1` (ci)
2. **Task 2: Write the D-04 Option A bootstrap procedure document** — `9b22be2` (docs)

## Next Phase Readiness

- Plan 02 has landed both deliverables that block the v0.16.2 release: the CI workflow file (inert) and the bootstrap procedure documentation. The maintainer can now (a) merge Plan 01 + Plan 02 + Plan 03 (when complete) to main, (b) let release-please cut v0.16.2 via the next `chore(main): release` PR, (c) execute D-04 steps 1-4 from the bootstrap doc to reserve the package name and attach trusted-publisher rules, and (d) cut v0.16.3 to validate the OIDC publish + smoke-test path end-to-end.
- Plan 03 (README quickstart rewrite, CLAUDE.md NOMAD_REPO note, install.sh deletion) is unblocked by both Plan 01 (publish metadata + `--version` arm) and Plan 02 (workflow file). The two plans are isolated: Plan 02 touched only `.github/workflows/` and `.planning/`; Plan 03 will touch root-level docs and source files.
- No blockers. No deferred items written to `deferred-items.md`.

## Self-Check: PASSED

- Files: `.github/workflows/npm-publish.yml` present at the exact path; `.planning/phases/08-npm-publish-bin-distribution/08-02-BOOTSTRAP.md` present and force-added (matches plan 01's pattern); `08-02-SUMMARY.md` being created now.
- Commits: `94956b1` (ci/Task 1) and `9b22be2` (docs/Task 2) both reachable via `git log --oneline`.
- Four gates green; 398/398 tests pass.

---
*Phase: 08-npm-publish-bin-distribution*
*Completed: 2026-05-21*
