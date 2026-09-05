import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { green, okGlyph, warnGlyph, yellow } from '../../../color.ts';
import { addItem, type DoctorSection } from '../format.ts';
import { repoHome } from '../../../config.ts';
import type { SpawnSyncFn } from '../../../gh-actions.ts';

/**
 * Cross-platform doctor diagnostic that flags a REPO_HOME exposed to git's
 * line-ending conversion. The sync repo's content (settings JSON, CLAUDE.md,
 * skills, session `.jsonl` transcripts) is byte-managed: nomad's drift
 * comparisons and gitleaks scans operate on exact bytes, so a checkout that
 * rewrites line endings permanently diverges that host's copy from every
 * other host's. `cmdInit` scaffolds new repos with a root `.gitattributes`
 * carrying `* -text` (see `src/init.ts`); this check WARNs (never FAILs) when
 * an existing repo lacks that guard, so an older or hand-cloned repo gets a
 * nudge to add it. No `process.platform` gate: a posix host with
 * `core.autocrlf` set is just as hazardous to the shared repo as a Windows
 * one, so the probe runs everywhere.
 */

/**
 * Node-level timeout for the `git config core.autocrlf` probe. Mirrors the
 * bounded subprocess convention in `commands/doctor/checks/deps.ts`
 * (PROBE_TIMEOUT_MS) so a wedged git process cannot hang the synchronous
 * `cmdDoctor` run. A timeout kill surfaces as a thrown error, which the
 * probe's `catch` already maps to an `unset` verdict, preserving the
 * no-exitCode contract.
 */
const PROBE_TIMEOUT_MS = 3_000;

/** Matches a `* -text` guard line (any amount of whitespace between tokens). */
const GUARD_LINE = /^\*\s+-text\b/;

/**
 * True when `REPO_HOME/.gitattributes` exists and contains a non-comment
 * line matching `* -text` (git line-ending conversion disabled for every
 * path). Tolerant: a missing or unreadable file reads as "no guard" rather
 * than throwing, matching the WARN-not-FAIL contract.
 *
 * @param repo - Absolute path to the sync repo root.
 */
function hasGitattributesGuard(repo: string): boolean {
  try {
    const path = join(repo, '.gitattributes');
    if (!existsSync(path)) return false;
    const content = readFileSync(path, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .some((line) => line !== '' && !line.startsWith('#') && GUARD_LINE.test(line));
  } catch {
    return false;
  }
}

/** Classification of the probed `core.autocrlf` value. */
type AutocrlfVerdict = 'active' | 'unset' | 'disabled';

/**
 * Probe `git -C <repo> config core.autocrlf` via the injected runner and
 * classify the result. A trimmed value of `true` or `input` means git is
 * actively converting line endings on checkout right now (`active`); a
 * trimmed value of `false` means the host is explicitly guarded already
 * (`disabled`); an unset key, any other value, or a thrown probe (e.g. not a
 * git repo) reads as `unset` (a latent risk, nothing converting yet or
 * known). Never throws.
 *
 * @param repo - Absolute path to the sync repo root.
 * @param run - Injectable subprocess runner.
 */
function probeAutocrlf(repo: string, run: SpawnSyncFn): AutocrlfVerdict {
  try {
    const out = run('git', ['-C', repo, 'config', 'core.autocrlf'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    })
      .toString()
      .trim();
    if (out === 'true' || out === 'input') return 'active';
    if (out === 'false') return 'disabled';
    return 'unset';
  } catch {
    return 'unset';
  }
}

/**
 * Risk wording per `AutocrlfVerdict`: active conversion (checkout is
 * rewriting line endings right now), an explicit `core.autocrlf=false` on
 * this host (this host is already guarded, but no `.gitattributes` means
 * other hosts are not), or a latent missing-guard risk (nothing converting
 * yet, but nothing stopping it either, and the config state is unknown).
 */
const AUTOCRLF_RISK: Record<AutocrlfVerdict, string> = {
  active: 'core.autocrlf is actively converting line endings on checkout',
  disabled:
    'guarded on this host by core.autocrlf=false, but no .gitattributes to protect other hosts',
  unset: 'no .gitattributes guard and core.autocrlf is unset (latent risk)',
};

/**
 * Emit the WARN row for an exposed REPO_HOME (guard absent). Looks up the
 * risk wording for `verdict` in `AUTOCRLF_RISK` and appends the same
 * remediation hint naming the two fixes and the REPO_HOME path.
 *
 * @param section - The section to append the row to.
 * @param repo - Absolute path to the sync repo root (named in the hint).
 * @param verdict - The classified `core.autocrlf` state.
 */
function addExposedRow(section: DoctorSection, repo: string, verdict: AutocrlfVerdict): void {
  const risk = AUTOCRLF_RISK[verdict];
  const remediation = `add a .gitattributes with a \`* -text\` line, or run \`git config core.autocrlf false\`, in ${repo}`;
  addItem(section, `${yellow(warnGlyph)} CRLF guard: ${risk}; ${remediation}`);
}

/**
 * Emit one OK/WARN row reporting whether REPO_HOME is exposed to git
 * line-ending conversion. OKs when `.gitattributes` carries a `* -text`
 * guard line; WARNs (with a remediation hint) when the guard is absent,
 * wording the row for active `core.autocrlf` conversion or a latent
 * missing-guard risk. Runs on every platform (no `process.platform` gate)
 * and never sets `process.exitCode`.
 *
 * @param section - The Environment section to append the row to.
 * @param run - Injectable subprocess runner; defaults to `execFileSync`.
 */
export function reportCrlfGuardCheck(
  section: DoctorSection,
  run: SpawnSyncFn = execFileSync,
): void {
  const repo = repoHome();
  if (hasGitattributesGuard(repo)) {
    addItem(section, `${green(okGlyph)} CRLF guard: .gitattributes (* -text) present`);
    return;
  }
  addExposedRow(section, repo, probeAutocrlf(repo, run));
}
