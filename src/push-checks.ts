/**
 * Reusable helpers for push-boundary safety: gitlink walker, gitleaks
 * presence probe, and rebase-before-push.
 *
 * The staged gitleaks scan lives in `./push-gitleaks.ts` so the
 * session-aware FATAL builder has its own module under the 200-line cap.
 * `gitleaksInstallHint` stays here because both `probeGitleaks`
 * (top-of-flow) and `runGitleaksScan` (mid-flow) need the platform-aware
 * install scaffold on ENOENT.
 *
 * All execFileSync-backed helpers use argv-array form with
 * `stdio: ['ignore', 'pipe', 'pipe']` (no shell). Same shape as
 * `gitStatusPorcelainZ` in src/utils.ts so the audit surface is uniform.
 *
 * Used by `cmdPush` for refuse-on-hit safety and by `cmdDoctor` for
 * read-only diagnostics (doctor only consumes `findGitlinks` and
 * `probeGitleaks`).
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, type Dirent } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import { REPO_HOME } from './config.ts';
import { resolveTomlConfig } from './push-gitleaks.config.ts';
import { NomadFatal } from './utils.ts';

/**
 * Platform-aware "gitleaks not on PATH" hint, mirroring the scaffold
 * `install.sh` prints during onboarding:
 *   - macOS: `brew install gitleaks`.
 *   - Linux: numbered steps (download arch-matched tarball, extract to
 *            `~/.local/bin`, optional PATH note when the dir isn't on PATH).
 *   - Other: just the release-page link.
 * Evaluated at call time so the PATH-on-rc check reflects the runtime
 * env, not the value at module load.
 */
export function gitleaksInstallHint(): string {
  const head = 'gitleaks not on PATH (required for nomad push). Install:';
  const plat = platform();
  if (plat === 'darwin') {
    return `${head}\n  brew install gitleaks`;
  }
  if (plat === 'linux') {
    const archMap: Record<string, string> = { x64: 'x64', arm64: 'arm64', arm: 'armv7' };
    const arch = archMap[process.arch];
    const lines = [
      head,
      arch
        ? `  1. Download the linux_${arch} tarball: https://github.com/gitleaks/gitleaks/releases`
        : `  1. Download the linux artifact for arch=${process.arch}: https://github.com/gitleaks/gitleaks/releases`,
      '  2. Install (replace TARBALL with the path to your download):',
      '       mkdir -p ~/.local/bin',
      '       tar -xzf TARBALL -C ~/.local/bin gitleaks',
      '       chmod +x ~/.local/bin/gitleaks',
      '       ~/.local/bin/gitleaks version   # verify',
    ];
    const localBin = `${homedir()}/.local/bin`;
    const paths = (process.env.PATH ?? '').split(':');
    if (!paths.includes(localBin)) {
      lines.push(
        '  3. ~/.local/bin is not on PATH; add to your shell rc:',
        '       export PATH="$HOME/.local/bin:$PATH"',
      );
    }
    return lines.join('\n');
  }
  return `${head}\n  See https://github.com/gitleaks/gitleaks/releases`;
}

/**
 * Recursively find every entry whose basename is `.git` under `dir`. Returns
 * absolute paths. Used by `cmdPush` (refuse-on-hit) and `cmdDoctor`
 * (read-only diagnostic). Callers feed `REPO_HOME/shared/` only; the tool's
 * own repo .git at `~/claude-nomad/.git/` is outside the walk root.
 *
 * Does NOT follow symlinks. `Dirent.isDirectory()` returns `false` for
 * `S_IFLNK` entries even when the link target is a directory, so the
 * recursion naturally short-circuits at any symlink. This is the
 * load-bearing fix for a known hazard: `readdirSync` in recursive mode
 * follows self-referential symlink cycles up to libuv's internal cap
 * (empirically verified on Node 22.16: 82 entries at depth 83 before the
 * cap fired). The hand-rolled walker below is cycle-safe by construction.
 *
 * Tolerates permission errors silently (returns whatever was collected before
 * the error). Reports both file gitlinks (submodule pointer) and directory
 * gitlinks (real nested repo); both push as gitlinks and both break clone.
 */
export function findGitlinks(dir: string): string[] {
  const hits: string[] = [];
  function walk(current: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(current, e.name);
      if (e.name === '.git') {
        hits.push(p);
        continue;
      }
      if (e.isDirectory()) walk(p);
    }
  }
  walk(dir);
  return hits;
}

/**
 * Probe for the gitleaks binary on PATH. Returns the trimmed `gitleaks
 * version` stdout on success. Throws NomadFatal with the install hint on
 * ENOENT; throws NomadFatal with the error message on any other failure.
 * Used by `cmdPush` (top-of-flow probe) and `cmdDoctor` (read-only).
 *
 * Passes `--config <toml>` resolved via `resolveTomlConfig`, which applies the
 * user-owned `.gitleaks.overlay.toml` allowlist on top of the bundled base (or
 * delegates to the two-tier `resolveTomlPath` lookup when no overlay exists).
 * `gitleaks version` ignores the flag empirically on 8.30.1, so the wiring is
 * conservative: symmetric with `runGitleaksScan` and surfaces a malformed toml
 * early if a future gitleaks version starts parsing the config on the `version`
 * subcommand. Omits the flag when no config resolves; behavior reverts to the
 * default ruleset. When the overlay merge generates a temp config its `tempPath`
 * is removed in the `finally` on every path. Throws NomadFatal with the install
 * hint on ENOENT; throws NomadFatal with the error message on any other failure.
 */
export function probeGitleaks(): string {
  const { path: toml, tempPath } = resolveTomlConfig();
  const args: string[] = ['version'];
  if (toml !== null) args.push('--config', toml);
  try {
    return execFileSync('gitleaks', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') throw new NomadFatal(gitleaksInstallHint());
    throw new NomadFatal(`gitleaks --version failed: ${e.message}`);
  } finally {
    if (tempPath !== null) rmSync(tempPath, { recursive: true, force: true });
  }
}

/**
 * Run `git pull --rebase --autostash` in REPO_HOME before push.
 * The `--autostash` absorbs dirty trees (in-progress path-map.json edits,
 * host overrides) so users do not need to commit-or-stash first.
 *
 * On failure, forwards git's stderr so the user sees the actual reason
 * (conflict, no-upstream, unreachable remote, auth failure, etc.), then
 * throws NomadFatal.
 *
 * FATAL wording references `git rebase --continue` / `--abort` (not the
 * stash list): when `--autostash` is in flight, the stashed work lives in
 * `.git/rebase-merge/autostash` mid-conflict and is reapplied by
 * `--continue` / `--abort` automatically. Pointing the user at the stash
 * list would mislead them; the recovery commands are the actual fix.
 *
 * `cmdPull` may adopt the same helper in a future refactor.
 */
export function rebaseBeforePush(): void {
  try {
    execFileSync('git', ['pull', '--rebase', '--autostash'], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    if (e.stderr) process.stderr.write(e.stderr);
    throw new NomadFatal(
      'rebase failed; if a conflict was reported, resolve it in ~/claude-nomad/ and run "git rebase --continue" (or "git rebase --abort" to give up). Re-run nomad push after resolution.',
    );
  }
}
