---
phase: 08-npm-publish-bin-distribution
plan: 03
subsystem: docs
tags: [docs, readme, claude-md, install-sh, npm-i, nomad-repo, backwards-compat]

requires:
  - phase: 08-01
    provides: NOMAD_REPO env override + doctor (NOMAD_REPO) annotation (constraint on CLAUDE.md replacement paragraph and README NOMAD_REPO mention)
provides:
  - install.sh deleted from repo root
  - README Quickstart leading with `npm i -g claude-nomad` (first fenced block)
  - README Setup, Requirements, and Upgrading-the-tool sections aligned to the npm-install story
  - README hardcoded-REPO_HOME caveat replaced with a NOMAD_REPO note
  - CLAUDE.md Commands list updated (npm i -g claude-nomad replaces ./install.sh; local-only because the file is gitignored)
  - CLAUDE.md Runtime constraints replaced (NOMAD_REPO env-override replaces the hardcoded-path caveat; local-only)
  - Static SPEC §12 gate satisfied (dev scripts unchanged, shebang unchanged, no migration heuristic)
affects: [downstream-publish-rollout, real-host-smoke-test]

tech-stack:
  added: []
  patterns:
    - "Docs cleanup pattern: delete the deprecated artifact (install.sh), then sweep every reference across README.md and CLAUDE.md in a single commit so the docs stay consistent"

key-files:
  created:
    - .planning/phases/08-npm-publish-bin-distribution/08-03-SUMMARY.md
  modified:
    - README.md (worktree-tracked; merges via git)
    - CLAUDE.md (main-repo only; gitignored, edit is local and does not propagate via git)
  deleted:
    - install.sh

key-decisions:
  - "CLAUDE.md edit is local-only because the file is gitignored at the repo root (.gitignore:11:/CLAUDE.md). The grep-based SPEC §6 acceptance criteria pass against the on-disk file, but the change is not committed and does not merge through git. Documented in the Deviations section so the maintainer knows to re-apply the edit per-host (or to stop gitignoring CLAUDE.md in a future phase)."
  - "Em-dash avoided in the new CLAUDE.md Commands entry. Used a comma per CLAUDE.md 'Conventions' (no em-dashes anywhere), even though the surrounding lines in the existing ## Commands list already use em-dashes."
  - "Quickstart now uses TWO fenced code blocks (npm i + git clone) instead of one. The FIRST fenced block contains exactly `npm i -g claude-nomad` per SPEC §11 acceptance; the second covers cloning the private mirror and exporting NOMAD_HOST."

requirements-completed:
  - "SPEC §6"
  - "SPEC §7"
  - "SPEC §11"
  - "SPEC §12 (static gate only; dynamic real-host smoke deferred to maintainer per VALIDATION.md Manual-Only Verifications)"

duration: 5 min
completed: 2026-05-21
---

# Phase 8 Plan 03: Docs Cleanup Summary

**Delete install.sh; lead the README Quickstart with `npm i -g claude-nomad`; replace the hardcoded-REPO_HOME caveat in CLAUDE.md and README with a NOMAD_REPO note; existing alias users keep working unchanged.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-05-21T21:10:17Z
- **Completed:** 2026-05-21T21:15:08Z
- **Tasks:** 2 (Task 1: rewrite + delete; Task 2: read-only static verification gate)
- **Files modified:** 2 (README.md committed; CLAUDE.md edited local-only)
- **Files deleted:** 1 (install.sh)

## Accomplishments

- `install.sh` deleted from the repo root via `git rm` (staged-for-deletion `D` entry in worktree, committed as part of Task 1).
- README.md Quickstart first fenced code block contains exactly `npm i -g claude-nomad` (SPEC §11 acceptance).
- README.md "Upgrading the tool" documents both paths per D-02b: `npm update -g claude-nomad` (global-install users) AND `nomad update` (source-checkout developers).
- README.md hardcoded-REPO_HOME caveat (the paragraph that previously said "The CLI is hardcoded to operate on `~/claude-nomad/`") replaced with a NOMAD_REPO note explaining the env override + empty-string fallthrough semantics.
- CLAUDE.md (gitignored, edited in-place on the main checkout): `./install.sh` removed from `## Commands`; the hardcoded-path caveat in `## Runtime constraints worth knowing` replaced with the NOMAD_REPO env-override note matching SPEC §6.
- Static SPEC §12 gate satisfied: `package.json` `pull`/`push`/`doctor` scripts still chain `tsx src/nomad.ts <cmd>`; `src/nomad.ts` shebang still `#!/usr/bin/env -S npx tsx`; no migration heuristic introduced in `src/nomad.ts`, `src/commands.doctor.ts`, or `src/commands.doctor.checks.ts`.
- Four gates green: format, lint, typecheck, test (398/398 tests pass) both before and after the commit.
- Pre-commit grep counts: README.md install.sh refs 0 (was 8); CLAUDE.md install.sh refs 0 (was 1); CLAUDE.md `hardcoded` refs 0 (was 1); CLAUDE.md NOMAD_REPO refs 1 (was 0).

## Task Commits

1. **Task 1: Delete install.sh + sweep README/CLAUDE.md** - `c33a006` (docs)
   - Commit covers the `D install.sh` deletion + README.md rewrites. CLAUDE.md changes are NOT in the commit because the file is gitignored; they live on the maintainer's local disk only.

2. **Task 2: Static SPEC §12 verification** - no commit (read-only verification, no file modifications per plan).

## Files Created/Modified

### Created (committed)

- `.planning/phases/08-npm-publish-bin-distribution/08-03-SUMMARY.md` - This summary.

### Modified (committed)

- `README.md` (461 lines, was 452): Quickstart rewritten; Requirements section drops install.sh language; Setup section drops the `./install.sh` step and the alias snippet; Upgrading section gains the `npm update -g claude-nomad` global path; hardcoded-REPO_HOME caveat replaced with a NOMAD_REPO note.

### Modified (local-only, gitignored)

- `CLAUDE.md` (97 lines, unchanged from pre-edit count): `## Commands` line 11 replaced (`./install.sh, first-time host setup...` → `npm i -g claude-nomad, install or upgrade the CLI globally...`); `## Runtime constraints worth knowing` line 67 replaced (hardcoded-path caveat → NOMAD_REPO env-override note).

### Deleted (committed)

- `install.sh` (122 lines): Removed entirely via `git rm`. The propagation path it occupied (Node version check + tsx global install + alias print) is now handled by npm's `engines` field (Node >= 22.22.1) and the runtime `tsx` dependency landed in Plan 01.

## Verbatim Outputs (audit trail)

### First fenced code block in README Quickstart (lines 48-50)

```bash
npm i -g claude-nomad
```

### Replacement CLAUDE.md line 67 paragraph (NOMAD_REPO note)

> `REPO_HOME` resolves from `process.env.NOMAD_REPO` with empty-string fallthrough to `~/claude-nomad/` (see `src/config.ts`). Developers working from an alternate checkout can `export NOMAD_REPO=/path/to/repo` to point the CLI at their working tree. `nomad doctor` surfaces an active override via a trailing `(NOMAD_REPO)` annotation on the repo-state line.

### Replacement README hardcoded-REPO_HOME paragraph

> By default the CLI operates on `~/claude-nomad/` (see `REPO_HOME` in `src/config.ts`). Developers working from an alternate checkout can `export NOMAD_REPO=/path/to/repo` to point the CLI at their working tree without symlink gymnastics; `nomad doctor` surfaces an active override via a trailing `(NOMAD_REPO)` annotation on the repo-state line. Empty `NOMAD_REPO` falls through to the default, so a clobbered dotfile variable does not break the CLI.

## Decisions Made

- **Two-fenced-block Quickstart layout** - Splitting `npm i -g claude-nomad` from the `git clone` step into two separate fenced blocks makes the first-block grep assertion trivially true (SPEC §11) and visually separates the install step (per-host, one-shot) from the repo-clone step (per-host, infrequent).
- **`npm update -g claude-nomad` named in the Upgrading section** - D-02b decision in 08-CONTEXT.md preserved both `nomad update` (developer-source-checkout path) and the new global-install path. The README now leads the Upgrading section with a two-bullet split so users find the right path immediately.
- **Em-dash avoided on the new CLAUDE.md `## Commands` entry** - Surrounding lines in that list use em-dashes (a pre-existing project-conventions violation), but the new entry uses a comma. The plan's grep assertion (`grep -P '[\x{2013}\x{2014}]'`) would already have failed on the existing content; matching the convention rather than the surrounding style is the right call.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] CLAUDE.md is gitignored, so the edit is local-only and does not commit**
- **Found during:** Task 1, after the install.sh deletion and README edits.
- **Issue:** The plan's `files_modified` declares `CLAUDE.md`, but `.gitignore:11:/CLAUDE.md` means the file is intentionally untracked at the repo root. The worktree checkout did not contain `CLAUDE.md` because the file is gitignored. The verification grep commands in the plan target `/home/norm/git/claude-nomad/CLAUDE.md` (the main repo path), which DOES exist as a developer-overlay file.
- **Fix:** Edited `/home/norm/git/claude-nomad/CLAUDE.md` (main repo path) directly. The grep-based SPEC §6 acceptance criteria pass because the file's on-disk content changes. The change is NOT in the Task 1 commit (and cannot be, because gitignored); it lives on the maintainer's local disk only.
- **Files modified:** `/home/norm/git/claude-nomad/CLAUDE.md` (local-only, gitignored).
- **Verification:** `grep -c "install.sh" CLAUDE.md` returns 0; `grep -cF "hardcoded to ~/claude-nomad" CLAUDE.md` returns 0; `grep -c "NOMAD_REPO" CLAUDE.md` returns 1.
- **Committed in:** Not committed (gitignored). The maintainer should re-apply the same edit on any other host where CLAUDE.md exists, or remove the `.gitignore` entry in a future phase if the file is meant to be tracked.

**2. [Rule 1 - Bug-adjacent] First-fenced-block Quickstart restructure**
- **Found during:** Task 1, while rewriting the Quickstart.
- **Issue:** The original Quickstart had a SINGLE fenced block containing `git clone`, `./install.sh`, and the `alias` line. Per SPEC §11 acceptance, the FIRST fenced block must contain `npm i -g claude-nomad`. Simply replacing the contents of the original block to mix the npm install with the git clone would have made the grep ("first fenced block contains `npm i -g claude-nomad`") accidentally pass via context but failed the spirit of the rule (the first block should be the install command, not a multi-step mix).
- **Fix:** Split the original single fenced block into TWO separate fenced blocks: the first contains exactly `npm i -g claude-nomad`; the second covers the repo clone, `NOMAD_HOST` export, and a commented-out `NOMAD_REPO` example.
- **Files modified:** `/home/norm/git/claude-nomad/.claude/worktrees/agent-a403b544e776df2f1/README.md`.
- **Verification:** The Read tool confirms lines 48-50 contain `\`\`\`bash\nnpm i -g claude-nomad\n\`\`\`` as the first fenced block after `## Quickstart`.
- **Committed in:** `c33a006` (Task 1).

---

**Total deviations:** 2 auto-fixed (1 Rule 3 blocking; 1 Rule 1 bug-adjacent restructure).
**Impact on plan:** Auto-fix #1 (gitignored CLAUDE.md) is a planning oversight the maintainer should reconcile — either keep `/CLAUDE.md` gitignored and accept that edits are per-host, or untrack the gitignore entry in a future phase so the file can ship with the repo. Auto-fix #2 (Quickstart restructure) improves clarity and makes the SPEC §11 acceptance grep unambiguous; no scope creep.

## Issues Encountered

- **CLAUDE.md absent from worktree.** The worktree checkout at `.claude/worktrees/agent-a403b544e776df2f1/` did not include `CLAUDE.md` because git treats it as ignored. Initial read attempts via the Read tool against the worktree path returned `File does not exist`. Resolved by editing the main-repo path directly (Deviation #1 above).
- **Worktree merge-base diverged from expected.** The startup HEAD assertion expected `4f8ddf00362866f6a36563f659d2dc363a0a4ca1` as the base, but the worktree's initial HEAD was on a sibling agent's `8422e766f4a32ab30a7dedccba0a67a9f538fb8c`. Reset via `git reset --hard 4f8ddf00362866f6a36563f659d2dc363a0a4ca1` to align before any edits, per the worktree_branch_check protocol. No work was lost (no edits had been made yet at that point).
- **Em-dash style mismatch in CLAUDE.md `## Commands` list.** Surrounding lines in that list (`npm test`, `npx vitest run`, etc.) use em-dashes despite the project's "no em-dashes" convention. The new entry uses a comma to conform to convention; the pre-existing em-dashes are out-of-scope for this plan (Rule 1 scope boundary).

## User Setup Required

None. No external service configuration required. The maintainer's manual post-merge action is the SPEC §12 dynamic real-host smoke test (documented in VALIDATION.md "Manual-Only Verifications"): on `dell-wsl` (which still has the alias `alias nomad='tsx ~/claude-nomad/src/nomad.ts'` in `.bashrc`), run `nomad doctor` after Phase 8 ships to confirm identical behavior to pre-Phase-8. The static gate this plan satisfies confirms the code-level conditions are met; only the dynamic execution-on-real-host is deferred.

## Spot-checks (preservation of unchanged sections)

Per RESEARCH §9, the following sections must NOT change in this plan:

- `## Upgrading the tool` (line 291): Still present; gained a two-bullet `npm update -g` vs `nomad update` lead-in but the existing detailed body is unchanged. The legacy-shim sentence ("npm run update still exists as a legacy shim...") is preserved.
- `## Commands` (line 331): Still present; nomad-command table unchanged.
- `## Recovery flows` + `### nomad drop-session <id>` (lines 359, 361): Unchanged.
- `## Cross-OS resume` (line 430): Unchanged.
- Threat model: not a separate H2 section in this README; the gitleaks `.gitleaks.toml` allowlist policy section (under Recovery flows) is unchanged.

## Self-Check: PASSED

- **Files (worktree, committed):**
  - install.sh: `test ! -f` returns true (deleted) — PASS
  - README.md: present at 461 lines — PASS
  - .planning/phases/08-npm-publish-bin-distribution/08-03-SUMMARY.md: present after Write tool call — PASS

- **Files (main repo, gitignored):**
  - CLAUDE.md: present at 97 lines with edits applied — PASS

- **Commit:** `c33a006` reachable via `git log --oneline` — PASS

- **Plan acceptance commands (all run, all PASS):**
  - `test ! -f install.sh` — PASS
  - `! grep -q 'install.sh' README.md CLAUDE.md` — PASS
  - `! grep -q 'hardcoded to ~/claude-nomad' CLAUDE.md` — PASS
  - `grep -q 'NOMAD_REPO' CLAUDE.md` — PASS (1 match)
  - `grep -q 'npm i -g claude-nomad' README.md` — PASS (4 matches)
  - `! grep -P '[\x{2013}\x{2014}]' README.md` — PASS (0 em-dashes)
  - CLAUDE.md em-dashes: 14 pre-existing (out-of-scope for this plan; the new entry I added uses a comma per project conventions)

- **Static SPEC §12 gate:**
  - Three npm scripts (pull/push/doctor) still chain `tsx src/nomad.ts <cmd>` — PASS
  - `src/nomad.ts` line 1 shebang unchanged (`#!/usr/bin/env -S npx tsx`) — PASS
  - No migration heuristic in dispatcher or doctor — PASS

- **Four gates:** format:check / lint / typecheck / test all green; 398/398 tests pass — PASS.

## Next Phase Readiness

- README and CLAUDE.md now lead with `npm i -g claude-nomad`; install.sh is gone. The user-facing install story is consistent across the public README and the developer-local CLAUDE.md.
- The plan's outputs slot directly into Plan 02 (`.github/workflows/npm-publish.yml`): the workflow's smoke-test job invokes `npm i -g claude-nomad@<version>`, which is now the documented install path — README + CLI surface are aligned.
- SPEC §12 dynamic real-host smoke (on `dell-wsl` with the existing alias) is the only deferred item; it cannot be automated in CI and is the maintainer's responsibility post-merge.
- No blockers. Nothing written to `deferred-items.md`.

---
*Phase: 08-npm-publish-bin-distribution*
*Completed: 2026-05-21*
