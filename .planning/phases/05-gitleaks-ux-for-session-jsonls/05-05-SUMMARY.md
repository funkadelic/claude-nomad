---
phase: 05-gitleaks-ux-for-session-jsonls
plan: 05
subsystem: remap
tags: [push, remap, filter, cpSync, jsonl, srcfilter]

# Dependency graph
requires:
  - phase: 02-safe-sync-local-mutation
    provides: cpSync mirror-copy primitive and the existing remapPush flow (copyDir + backupRepoWrite)
  - phase: 03-safe-push-remote-boundary
    provides: gitleaks scan gate downstream of remapPush — SRCFILTER reduces the surface that scan has to police
provides:
  - copyDirJsonlOnly(src, dst): cpSync wrapped with a depth-0 jsonl-only filter
  - remapPush switched to copyDirJsonlOnly so stray local .bak/.tmp/.swp never enter the staged tree
  - 5 integration tests (top-level jsonl, depth-0 skip + log, depth>=1 subtree, source-root case, remapPull regression)
affects: [push, gitleaks-scan]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "cpSync filter callback with depth-aware allow-rules and a load-bearing source-root case (D-17 / Pitfall 1)"
    - "Per-skip log line for filter rejections (no cap, no dedup), idiomatic to remap.ts's existing log() conventions"

key-files:
  created: []
  modified:
    - src/remap.ts (added copyDirJsonlOnly; switched remapPush call site; 158 lines, under 200 cap)
    - src/remap.test.ts (added the SRCFILTER describe block with 5 integration tests; 612 lines)

key-decisions:
  - "D-14: copyDirJsonlOnly wraps Node 22's cpSync with a depth-aware filter; remapPull keeps the unfiltered copyDir because the repo side is already curated by the push gate"
  - "D-15: depth 0 under ~/.claude/projects/<encoded>/ is the filter boundary; subdirectory contents (subagents/, memory/, tool-results/) traverse unfiltered at depth >=1"
  - "D-16: per-skip log line, no cap, no dedup — one `[nomad] skip <rel>: extension not in allowlist` per skipped top-level entry"
  - "D-17 / Pitfall 1: filter callback explicitly allows the source root (`relative(src, srcPath) === ''`); a naive empty-rel handler would emit a spurious skip log and abort the entire copy"

patterns-established:
  - "cpSync filter, depth-aware: split relative path on sep to detect depth; allow the empty-rel root case before any other check"
  - "Filter side-effect rule: filter callbacks either return true silently OR call log() + return false; never log on a true path"

requirements-completed: [SRCFILTER]

# Metrics
duration: ~6 min
completed: 2026-05-21
---

# Phase 5 Plan 5: SRCFILTER — Source-Side jsonl-only Filter in remapPush Summary

**`copyDirJsonlOnly` adds a depth-0 extension allowlist to the push-side cpSync; stray `.bak`/`.tmp`/`.swp` files in `~/.claude/projects/<encoded>/` can no longer leak into the staged tree.**

## Performance

- **Duration:** ~6 min (commit timestamps span 2026-05-20T20:13:35-07:00 → 2026-05-20T20:15:11-07:00, plus SUMMARY write)
- **Started:** 2026-05-21T03:12:00Z (approx; first file read)
- **Completed:** 2026-05-21T03:16:00Z
- **Tasks:** 2 (TDD: RED → GREEN)
- **Files modified:** 2

## Accomplishments

- `copyDirJsonlOnly(src, dst)` in `src/remap.ts`: cpSync wrapped with a depth-aware filter. Root case allowed (D-17), depth>=1 entries pass unconditionally (D-15), depth-0 directories pass, depth-0 `.jsonl` files pass, depth-0 non-jsonl files skip with a one-line log (D-16).
- `remapPush` switched to use `copyDirJsonlOnly` instead of `copyDir`; `remapPull` keeps the unfiltered `copyDir` so the repo-curated side stays asymmetric (D-14).
- Five new tests in `src/remap.test.ts` under `describe('remapPush source-side filter (SRCFILTER)', ...)`. RED gate confirmed (case 2 failed against the unfiltered copyDir); GREEN confirmed after the implementation switch (all 18 remap tests pass).
- 2026-05-20 incident pattern (a `.bak` re-tripping gitleaks after a manual session scrub) cannot recur because the source-side filter blocks the `.bak` before it can enter `shared/projects/`.

## Task Commits

1. **Task 1: TDD — SRCFILTER integration tests in src/remap.test.ts (RED)** — `b1f5d90` (test)
2. **Task 2: Implement copyDirJsonlOnly and switch remapPush to use it (GREEN)** — `7551a68` (feat)

_TDD: RED → GREEN. No REFACTOR commit needed; the GREEN implementation matched the planned shape exactly._

## Files Created/Modified

- `src/remap.ts` — added `copyDirJsonlOnly` (helper with depth-aware cpSync filter + JSDoc explaining the source-root case); switched the one-line `copyDir` call in `remapPush` to `copyDirJsonlOnly`; extended the `node:fs` import with `statSync` and the `node:path` import with `relative, sep`. File grew from 129 → 158 lines, still well under the 200 cap.
- `src/remap.test.ts` — added a new top-level `describe('remapPush source-side filter (SRCFILTER)', ...)` block with 5 integration tests: top-level `.jsonl` pass-through, top-level `.bak`/`.tmp` skip with log assertion (logSpy captures), depth>=1 subtree traversal (subagents + memory fixtures), source-root-case no-spurious-skip assertion, and a `remapPull`-unchanged regression guard. Each test uses the same temp-`$HOME` harness as the existing remap tests.

## Decisions Made

None new. Followed D-14..D-17 verbatim from `05-CONTEXT.md` and the inline code in `05-PATTERNS.md §src/remap.ts`. No architectural choices made during execution.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] ESLint `no-empty-function` blocked the first commit attempt of Task 1**
- **Found during:** Task 1 (RED commit)
- **Issue:** The initial form `vi.spyOn(console, 'log').mockImplementation(() => {})` triggered `@typescript-eslint/no-empty-function` in the pre-commit `lint-staged` hook. The hook reverted the working-tree changes and the commit aborted.
- **Fix:** Adopted the project's idiomatic shape used elsewhere (`commands.push.test.ts`, `links.test.ts`): give the noop body a `/* captured */` comment so it is no longer an "empty" function per the rule. Replaced all three occurrences via `replace_all`.
- **Files modified:** `src/remap.test.ts`
- **Verification:** Re-ran `npx vitest run src/remap.test.ts` — still exactly 1 failure (case 2), confirming the RED gate held; second commit attempt succeeded with lint-staged passing.
- **Committed in:** `b1f5d90` (Task 1 commit, after the fix)

### Plan Acceptance Criteria — Minor Note

Task 2's acceptance criterion `grep -c "extension not in allowlist" src/remap.ts` returns `1` is documented as "returns `1`". Actual returns `2` because the JSDoc on `copyDirJsonlOnly` quotes the literal log message for documentation purposes. The log is still emitted from a single call site; behavior is identical. Not treated as a deviation — the criterion's intent (verify the log line is emitted once at runtime) is satisfied. Documenting it here for transparency.

---

**Total deviations:** 1 auto-fixed (1 Rule 3 — blocking commit hook fix to match project lint style)
**Impact on plan:** No scope creep. The lint-style fix is mechanical, mirrors the existing in-tree convention, and changes no test semantics.

## Issues Encountered

- Pre-commit `lint-staged` hook bounced the first Task 1 commit (see Deviation 1). Recovered by adjusting the spy-noop syntax to match the in-tree idiom; second commit clean.

## User Setup Required

None — no external service configuration required. The change is internal to `nomad push` and ships through the existing `nomad update` topology-aware merge.

## Next Phase Readiness

- SRCFILTER is independent of Plans 01..04 in this phase (wave-1 parallel slot). The other Wave-1 plans (SESSAWARE / SESSAWARE-MSG / DROPSESSION / ALLOWLIST) can land in any order; SRCFILTER does not block them.
- The push gate downstream of `remapPush` (gitleaks scan via `runGitleaksScan`) now sees a strictly cleaner staged tree. No code-level integration concern; the contract is "fewer files enter `shared/projects/`."
- Manual sanity check still required at phase-merge time: create a `.bak` file in `~/.claude/projects/<encoded>/`, run `nomad push --dry-run`, confirm a `[nomad] skip <rel>: extension not in allowlist` line appears in stdout. Tracked in the plan's `<verification>` block; not blocking SUMMARY.

## Self-Check: PASSED

- `src/remap.ts` — FOUND (158 lines, contains `function copyDirJsonlOnly`)
- `src/remap.test.ts` — FOUND (contains `describe('remapPush source-side filter (SRCFILTER)`)
- Commit `b1f5d90` — FOUND in `git log` (Task 1 RED)
- Commit `7551a68` — FOUND in `git log` (Task 2 GREEN)
- Four gates exit 0: `npm test` (346/346), `npm run typecheck`, `npm run lint`, `npm run format:check`

## TDD Gate Compliance

- RED gate: `test(remap): add failing test for source-side jsonl-only filter` (`b1f5d90`) — case 2 (`.bak`/`tmp.txt` skip + log) failed against current `copyDir`; cases 1, 3, 4, 5 passed (regression guards).
- GREEN gate: `feat(remap): add copyDirJsonlOnly and switch remapPush to use it` (`7551a68`) — all 5 SRCFILTER tests pass alongside existing tests.
- REFACTOR: not needed; the GREEN implementation matched the planned shape one-for-one.

---
*Phase: 05-gitleaks-ux-for-session-jsonls*
*Plan: 05 (SRCFILTER)*
*Completed: 2026-05-21*
