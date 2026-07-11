import { execFileSync } from 'node:child_process';

import { dim, green, infoGlyph, okGlyph, warnGlyph, yellow } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import type { SpawnSyncFn } from './gh-actions.ts';

/**
 * Win32-only long-path diagnostics plus a cross-platform sync-modality row for
 * `nomad doctor`. Deep encoded session trees under `~/.claude/projects/<encoded>/`
 * can exceed the legacy Windows `MAX_PATH` (260 characters) limit unless
 * long-path support is enabled at both the git level (`core.longpaths`) and
 * the OS level (`LongPathsEnabled` registry value). This module probes both
 * states, read-only, and WARNs (never FAILs) when either is unset: a deep
 * path CAN overflow MAX_PATH but will not always, so this degrades gracefully
 * like every other doctor WARN (matches the header-comment contract in
 * `commands.doctor.checks.deps.ts`). It also reports the active sync modality
 * (copy-sync on win32, symlink on posix), an informational row only.
 */

/**
 * Node-level timeout for a `git config` / `reg query` probe. Mirrors the bounded
 * subprocess convention in `commands.doctor.checks.deps.ts` (PROBE_TIMEOUT_MS) so
 * a wedged binary cannot hang the synchronous `cmdDoctor` run. A timeout kill
 * surfaces as a thrown error, which each probe's `catch` already maps to a WARN
 * row, preserving the no-exitCode contract.
 */
const PROBE_TIMEOUT_MS = 3_000;

/** Registry path probed for the OS-level long-path opt-in. */
const LONGPATHS_REG_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem';

/** Registry value name probed under `LONGPATHS_REG_KEY`. */
const LONGPATHS_REG_VALUE = 'LongPathsEnabled';

/**
 * Probe `git config --get core.longpaths` via the injected runner. Returns
 * `true` when the trimmed stdout is `'true'` or `'1'`, `false` when the probe
 * throws (unset key, or any other error) or returns any other value. Never
 * throws: a thrown probe degrades to `false` (unset), matching the
 * WARN-not-FAIL contract.
 *
 * @param run - Injectable subprocess runner.
 */
function probeGitLongpaths(run: SpawnSyncFn): boolean {
  try {
    const out = run('git', ['config', '--get', 'core.longpaths'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    })
      .toString()
      .trim();
    return out === 'true' || out === '1';
  } catch {
    return false;
  }
}

/**
 * Probe the `LongPathsEnabled` registry value via the injected runner. Returns
 * `true` when the stdout contains `0x1`, `false` when the probe throws (e.g.
 * `reg.exe` absent, or the value is unset/disabled) or the output does not
 * match. Never throws.
 *
 * @param run - Injectable subprocess runner.
 */
function probeRegistryLongpaths(run: SpawnSyncFn): boolean {
  try {
    const out = run('reg', ['query', LONGPATHS_REG_KEY, '/v', LONGPATHS_REG_VALUE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    }).toString();
    return /0x1\b/.test(out);
  } catch {
    return false;
  }
}

/**
 * Emit one OK/WARN row for a single probed long-path state.
 *
 * @param section - The section to append the row to.
 * @param label - The user-facing label for this state (e.g. `git core.longpaths`).
 * @param enabled - Whether the probe classified this state as enabled.
 * @param remediation - Short hint shown on the WARN row.
 */
function addLongpathsRow(
  section: DoctorSection,
  label: string,
  enabled: boolean,
  remediation: string,
): void {
  if (enabled) {
    addItem(section, `${green(okGlyph)} ${label}: enabled`);
    return;
  }
  addItem(section, `${yellow(warnGlyph)} ${label}: not enabled (${remediation})`);
}

/**
 * Emit win32 long-path diagnostics into the given doctor section: one row for
 * `git config core.longpaths` and one row for the `LongPathsEnabled` registry
 * value. No-op on darwin/linux (returns immediately, spawns nothing, emits no
 * rows). Never sets `process.exitCode`: both states are WARN-only, since a
 * deep encoded session path may or may not actually exceed `MAX_PATH`.
 *
 * @param section - The Environment section to append rows to.
 * @param run - Injectable subprocess runner; defaults to `execFileSync`.
 */
export function reportLongPathsCheck(
  section: DoctorSection,
  run: SpawnSyncFn = execFileSync,
): void {
  if (process.platform !== 'win32') return;
  addLongpathsRow(
    section,
    'git core.longpaths',
    probeGitLongpaths(run),
    'run `git config --global core.longpaths true`',
  );
  addLongpathsRow(
    section,
    'OS long paths',
    probeRegistryLongpaths(run),
    'enable LongPathsEnabled in Local Group Policy or the registry (admin required)',
  );
}

/**
 * Emit a single informational row naming the active sync modality: copy-sync
 * on win32 (symlinks need Developer Mode/admin there), symlink everywhere
 * else. Mirrors the `dim(infoGlyph)` informational-row style `reportHostAndPaths`
 * uses. Never sets `process.exitCode`.
 *
 * @param section - The Environment section to append the row to.
 */
export function reportSyncModality(section: DoctorSection): void {
  const modality = process.platform === 'win32' ? 'copy-sync (win32)' : 'symlink (posix)';
  addItem(section, `${dim(infoGlyph)} sync modality: ${modality}`);
}
