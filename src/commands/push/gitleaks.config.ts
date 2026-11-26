/**
 * Resolves the gitleaks `--config` path for every scan site, layering a
 * user-owned `REPO_HOME/.gitleaks.overlay.toml` allowlist ON TOP of the
 * package-bundled `.gitleaks.toml` via a generated temp config that `extend`s it.
 *
 * Owns both tiers of gitleaks `--config` resolution: the two-tier
 * `resolveTomlPath` base lookup and the `resolveTomlConfig` overlay merge built
 * on top of it. Co-locating them here (rather than importing `resolveTomlPath`
 * from `gitleaks.scan.ts`) keeps the dependency one-directional
 * (`gitleaks.scan.ts` + `checks.ts` -> this module); this module
 * imports only `config.ts`, `package-root.ts`, `utils.ts`, and the leaf
 * `gitleaks.overlay-guard.ts`, so there is no cycle.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoHome } from '../../core/config.ts';
import { packageRoot } from '../../core/package-root.ts';
import { NomadFatal, warn } from '../../core/utils.ts';
import { assertOverlaySafe } from './gitleaks.overlay-guard.ts';

/**
 * Two-tier `.gitleaks.toml` lookup: returns `REPO_HOME/.gitleaks.toml` when
 * present, else the package-bundled copy resolved via `packageRoot()` (always
 * current with the installed binary, critical for standalone repos that have
 * no git update path for the allowlist), else `null`. Callers omit `--config`
 * on a `null` return so gitleaks uses its default ruleset; scanning is never
 * disabled. Used by `resolveTomlConfig` below and by `checks.ts`
 * `probeGitleaks`.
 *
 * The `null` return covers only "no bundled file at this package root", the
 * ordinary and already-tolerated absence case. A `packageRoot()` failure means
 * something else. No `package.json` above the CLI at all is a broken install,
 * not a missing optional file. Returning `null` for it would be
 * indistinguishable from the merely-absent case and would drop the scanner to
 * gitleaks' default ruleset with no signal that the install is corrupt, so this
 * aborts instead. It is re-thrown as `NomadFatal` rather than left as the raw
 * `Error`, which would reach `handleCrash` and write a crash report telling the
 * user to file a bug when the actionable answer is to reinstall.
 *
 * @param repo Repo root; defaults to `repoHome()` for direct callers, while
 *   `resolveTomlConfig` passes its already-captured root so the whole
 *   overlay/base precedence chain resolves against one repo.
 */
export function resolveTomlPath(repo: string = repoHome()): string | null {
  const repoToml = join(repo, '.gitleaks.toml');
  if (existsSync(repoToml)) return repoToml;
  let root: string;
  try {
    root = packageRoot();
  } catch {
    throw new NomadFatal(
      'claude-nomad install looks incomplete (no package.json above the CLI); reinstall with `npm i -g claude-nomad`',
    );
  }
  const bundled = join(root, '.gitleaks.toml');
  return existsSync(bundled) ? bundled : null;
}

/**
 * Result of `resolveTomlConfig`. A discriminated union (TYPE, not enum or
 * class, to satisfy `erasableSyntaxOnly`):
 *   - `tempPath: null`  -> no temp config was generated (no overlay, S-01
 *     precedence, bundled-base absent, or a generation-failure fallback);
 *     `path` is whatever `resolveTomlPath` would return (possibly `null`).
 *   - `tempPath: string` -> an overlay was merged into a generated temp config;
 *     `tempPath` is the private temp DIRECTORY holding it, `path` is the config
 *     file inside that directory, and the caller MUST remove `tempPath`
 *     recursively (`rmSync(tempPath, { recursive: true, force: true })`) in a
 *     `finally` once gitleaks has run.
 */
export type TomlConfigResult = (
  { path: string | null; tempPath: null } | { path: string; tempPath: string }
) & {
  /** Set only in quiet mode: the overlay notice the caller should render itself. */
  notice?: string;
};

/** Notice kinds already surfaced this process; keyed by kind since merge-failure text varies. */
const emittedNotices = new Set<'precedence' | 'merge-failed'>();

/**
 * Surface an overlay notice at most once per process. Quiet mode returns the
 * message (always) for the caller to render; otherwise it is warned the first
 * time and `undefined` is returned.
 *
 * @param kind Which notice this is, used as the dedupe key.
 * @param message The notice text.
 * @param quiet True when the caller renders the notice itself.
 */
function notify(
  kind: 'precedence' | 'merge-failed',
  message: string,
  quiet: boolean,
): string | undefined {
  const seen = emittedNotices.has(kind);
  emittedNotices.add(kind);
  if (quiet) return message;
  if (!seen) warn(message);
  return undefined;
}

/**
 * Read the overlay body and write the generated temp config that chains it onto
 * the bundled base. Separated from `resolveTomlConfig` so the I/O try/catch
 * (the generation-failure fallback) is a tight seam and the caller stays under
 * the cognitive-complexity gate. The overlay guard is intentionally NOT
 * here: it runs in `resolveTomlConfig` BEFORE this call so its `NomadFatal` is
 * never swallowed by the generation-failure fallback catch.
 *
 * The temp body is `extend = { path = <bundled abs path JSON> }\n\n<overlay body>` (an
 * inline table, so the overlay's leading bare keys stay top-level, not in `extend`).
 * It is written as `config.toml` inside a private
 * directory created atomically with `mkdtempSync` (mode 0o700) under `tmpdir()`
 * with a `nomad-gitleaks-cfg-` prefix (CWE-377: the private dir plus the `wx`
 * exclusive-create flag defeat a symlink-redirect in the world-writable temp
 * dir). The config file is written mode 0o600. If the write fails the directory
 * is removed before the error is rethrown. The `extend` path is ABSOLUTE because
 * the scan CWD is never the package root (a scratch repo, or uncontrolled at the
 * `probeGitleaks` site).
 *
 * @param overlayBody The already-read overlay body (read once by the caller so a
 *   single buffer is both guarded and spliced, closing the guard/build TOCTOU).
 * @param bundled Absolute path to the bundled `.gitleaks.toml` (from `resolveTomlPath`).
 * @returns The generated temp directory and the config file path inside it.
 */
function buildOverlayTempConfig(
  overlayBody: string,
  bundled: string,
): { configPath: string; tempPath: string } {
  const tempBody = `extend = { path = ${JSON.stringify(bundled)} }\n\n${overlayBody}\n`;
  const tempPath = mkdtempSync(join(tmpdir(), 'nomad-gitleaks-cfg-'));
  const configPath = join(tempPath, 'config.toml');
  try {
    writeFileSync(configPath, tempBody, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    rmSync(tempPath, { recursive: true, force: true });
    throw err;
  }
  return { configPath, tempPath };
}

/**
 * Resolve the gitleaks `--config` path, applying a user-owned
 * `REPO_HOME/.gitleaks.overlay.toml` allowlist ON TOP of the package-bundled
 * `.gitleaks.toml` (which itself `[extend] useDefault = true` chains the gitleaks
 * default ruleset). Implements Approach A (chain), empirically verified at
 * gitleaks 8.30.1: the generated temp config `extend = { path = <bundled abs> }` plus
 * the overlay body loads as temp -> bundled(useDefault) -> default, exactly the
 * depth-2 `maxExtendDepth` limit (depth 3 SILENTLY drops the default ruleset).
 * The caller owns cleanup: when `tempPath` is non-null it MUST be removed in a
 * `finally`.
 *
 * Branches:
 *   - No overlay file: delegates to `resolveTomlPath()`, `tempPath: null`. Byte
 *     identical to the pre-overlay behavior.
 *   - S-01 precedence: if a full `REPO_HOME/.gitleaks.toml` exists,
 *     `resolveTomlPath()` returns IT first; the overlay is ignored with a
 *     notice (warned once per process), `tempPath: null`. A full repo toml
 *     signals manual control and may itself `[extend]`, so interposing the
 *     overlay would risk the depth-3 silent drop; the repo toml wins outright
 *     to keep the chain at the safe depth-2 max.
 *   - Overlay present, no full repo toml, bundled base absent: falls back to
 *     `{ path: null, tempPath: null }` so gitleaks still runs with its default
 *     ruleset (never no-scan, never skipped).
 *   - Overlay that is not valid TOML, or has its own `[extend]` block: throws `NomadFatal`
 *     BEFORE generating the temp, so a dangerous/malformed overlay fails LOUD and
 *     aborts the push rather than silently weakening the scan.
 *   - Overlay present with an unscoped allowlist (a block lacking `paths`, or a
 *     catch-all `.*`/`.+` pattern): throws `NomadFatal` before generating the
 *     temp. An unscoped allowlist would suppress findings repo-wide and, because
 *     the overlay syncs across hosts, disable scanning fleet-wide.
 *   - Overlay present, bundled base resolvable: generates the temp config and
 *     returns `{ path: tempPath, tempPath }`.
 *   - Generation failure for any reason: if reading the overlay or the bundled
 *     base, or writing the temp, throws (ENOSPC, EACCES, EROFS, missing tmpdir,
 *     unreadable overlay, etc.), emit a notice (once per process) and fall back
 *     to the BUNDLED base path so the scan STILL runs with the full bundled
 *     allowlist. Never returns `path: null` here, and
 *     never skips. The `[extend]` `NomadFatal` is thrown outside the fallback
 *     try, so it is never swallowed by this catch, as is the broken-install
 *     `NomadFatal` from the `resolveTomlPath` call that precedes it.
 *
 * In quiet mode each notice is returned on the result instead of being printed.
 *
 * @param options.quiet Return the notice on the result instead of printing it.
 * @returns A `TomlConfigResult`; the caller passes `path` to `--config` (omitting
 *   the flag on `null`) and removes a non-null `tempPath` in a `finally`.
 */
export function resolveTomlConfig({ quiet = false }: { quiet?: boolean } = {}): TomlConfigResult {
  const repo = repoHome();
  const overlayPath = join(repo, '.gitleaks.overlay.toml');
  const repoToml = join(repo, '.gitleaks.toml');
  const bundled = resolveTomlPath(repo);
  if (!existsSync(overlayPath)) {
    return { path: bundled, tempPath: null };
  }
  // S-01: a full REPO_HOME/.gitleaks.toml wins outright; resolveTomlPath returns
  // it before the bundled copy, so compare to detect that case and short-circuit
  // before generating a temp (keeps the chain at the safe depth-2 max).
  if (bundled === repoToml) {
    const notice = notify(
      'precedence',
      `.gitleaks.overlay.toml ignored: ${repoToml} takes precedence. Delete .gitleaks.toml to use the overlay, or delete the overlay to silence this notice.`,
      quiet,
    );
    return { path: bundled, tempPath: null, notice };
  }
  // No bundled base to chain onto; run with the default ruleset, never skip.
  if (bundled === null) {
    return { path: null, tempPath: null };
  }
  // Any overlay-read or temp-generation I/O failure falls back to the
  // bundled base so the scan still runs with the full bundled allowlist (never
  // null, never thrown). The overlay is read ONCE here and the same buffer is
  // both guarded and spliced, closing the guard-vs-build TOCTOU. The
  // [extend] NomadFatal is re-thrown from the catch so it is never swallowed by
  // this fallback.
  try {
    const overlayBody = readFileSync(overlayPath, 'utf8');
    assertOverlaySafe(overlayBody);
    const { configPath, tempPath } = buildOverlayTempConfig(overlayBody, bundled);
    return { path: configPath, tempPath };
  } catch (err) {
    if (err instanceof NomadFatal) throw err;
    const notice = notify(
      'merge-failed',
      `.gitleaks.overlay.toml merge failed (${(err as Error).message}); falling back to the bundled allowlist`,
      quiet,
    );
    return { path: bundled, tempPath: null, notice };
  }
}
