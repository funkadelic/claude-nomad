/**
 * Resolves the gitleaks `--config` path for every scan site, layering a
 * user-owned `REPO_HOME/.gitleaks.overlay.toml` allowlist ON TOP of the
 * package-bundled `.gitleaks.toml` via a generated temp `[extend]` chain.
 *
 * Owns both tiers of gitleaks `--config` resolution: the two-tier
 * `resolveTomlPath` base lookup and the `resolveTomlConfig` overlay merge built
 * on top of it. Co-locating them here (rather than importing `resolveTomlPath`
 * from `push-gitleaks.scan.ts`) keeps the dependency one-directional
 * (`push-gitleaks.scan.ts` + `push-checks.ts` -> this module); this module
 * imports only `config.ts`, `utils.fs.ts`, and `utils.ts`, so there is no cycle.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_HOME } from './config.ts';
import { NomadFatal, warn } from './utils.ts';

/**
 * Two-tier `.gitleaks.toml` lookup: returns `REPO_HOME/.gitleaks.toml` when
 * present, else the package-bundled copy resolved via `import.meta.url`
 * (always current with the installed binary, critical for standalone repos
 * that have no git update path for the allowlist), else `null`. Callers omit
 * `--config` on a `null` return so gitleaks uses its default ruleset; scanning
 * is never disabled. Used by `resolveTomlConfig` below and by `push-checks.ts`
 * `probeGitleaks`.
 */
export function resolveTomlPath(): string | null {
  const repoToml = join(REPO_HOME, '.gitleaks.toml');
  if (existsSync(repoToml)) return repoToml;
  const bundled = fileURLToPath(new URL('../.gitleaks.toml', import.meta.url));
  return existsSync(bundled) ? bundled : null;
}

/**
 * Result of `resolveTomlConfig`. A discriminated union (TYPE, not enum or
 * class, to satisfy `erasableSyntaxOnly`):
 *   - `tempPath: null`  -> no temp config was generated (no overlay, S-01
 *     precedence, bundled-base absent, or the D-04 generation-failure fallback);
 *     `path` is whatever `resolveTomlPath` would return (possibly `null`).
 *   - `tempPath: string` -> an overlay was merged into a generated temp config;
 *     `tempPath` is the private temp DIRECTORY holding it, `path` is the config
 *     file inside that directory, and the caller MUST remove `tempPath`
 *     recursively (`rmSync(tempPath, { recursive: true, force: true })`) in a
 *     `finally` once gitleaks has run.
 */
export type TomlConfigResult =
  | { path: string | null; tempPath: null }
  | { path: string; tempPath: string };

/**
 * Regex matching an `[extend]` definition at the start of a line (D-05). Covers
 * every TOML-equivalent form so the guard cannot be bypassed by whitespace or
 * key syntax: the table header `[extend]` with optional inner whitespace
 * (`[ extend ]`), the dotted-key form (`extend.path = ...`), and the inline-table
 * form (`extend = { ... }`). All three load the `extend` table in gitleaks' TOML
 * parser and would build the depth-3 chain that silently drops the default
 * ruleset, so all three must fail LOUD.
 */
const OVERLAY_EXTEND_RE = /^\s*(?:\[\s*extend\s*\]|extend\s*[.=])/m;

/**
 * Read the overlay body and write the generated temp config that chains it onto
 * the bundled base. Separated from `resolveTomlConfig` so the I/O try/catch
 * (D-04 fallback) is a tight seam and the caller stays under the
 * cognitive-complexity gate. The `[extend]` guard is intentionally NOT here: it
 * runs in `resolveTomlConfig` BEFORE this call so its `NomadFatal` (D-05) is
 * never swallowed by the D-04 fallback catch.
 *
 * The temp body is `[extend]\npath = <bundled abs path JSON>\n\n<overlay body>`,
 * written as `config.toml` inside a private directory created atomically with
 * `mkdtempSync` (mode 0o700) under `tmpdir()` with a `nomad-gitleaks-cfg-` prefix
 * (CWE-377: the private dir plus the `wx` exclusive-create flag defeat a
 * symlink-redirect in the world-writable temp dir). The config file is written
 * mode 0o600. The `[extend] path` is the ABSOLUTE bundled path (D-02, Pitfall 1)
 * because the scan CWD is uncontrolled at the `scanFile` and `probeGitleaks` sites.
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
  const tempBody = `[extend]\npath = ${JSON.stringify(bundled)}\n\n${overlayBody}`;
  const tempPath = mkdtempSync(join(tmpdir(), 'nomad-gitleaks-cfg-'));
  const configPath = join(tempPath, 'config.toml');
  writeFileSync(configPath, tempBody, { mode: 0o600, flag: 'wx' });
  return { configPath, tempPath };
}

/**
 * Resolve the gitleaks `--config` path, applying a user-owned
 * `REPO_HOME/.gitleaks.overlay.toml` allowlist ON TOP of the package-bundled
 * `.gitleaks.toml` (which itself `[extend] useDefault = true` chains the gitleaks
 * default ruleset). Implements Approach A (chain), empirically verified at
 * gitleaks 8.30.1: the generated temp config `[extend] path = <bundled abs>` plus
 * the overlay body loads as temp -> bundled(useDefault) -> default, exactly the
 * depth-2 `maxExtendDepth` limit (depth 3 SILENTLY drops the default ruleset).
 * The caller owns cleanup: when `tempPath` is non-null it MUST be removed in a
 * `finally`.
 *
 * Branches:
 *   - No overlay file: delegates to `resolveTomlPath()`, `tempPath: null`. Byte
 *     identical to the pre-overlay behavior.
 *   - S-01 precedence: if a full `REPO_HOME/.gitleaks.toml` exists,
 *     `resolveTomlPath()` returns IT first; the overlay is ignored with a single
 *     `warn`, `tempPath: null`. A full repo toml signals manual control and may
 *     itself `[extend]`, so interposing the overlay would risk the depth-3 silent
 *     drop; the repo toml wins outright to keep the chain at the safe depth-2 max.
 *   - Overlay present, no full repo toml, bundled base absent: D-04 fallback,
 *     `{ path: null, tempPath: null }` so gitleaks still runs with its default
 *     ruleset (never no-scan, never skipped).
 *   - Overlay present with its own `[extend]` block: throws `NomadFatal` (D-05)
 *     BEFORE generating the temp, so a dangerous/malformed overlay fails LOUD and
 *     aborts the push rather than silently weakening the scan.
 *   - Overlay present, bundled base resolvable: generates the temp config and
 *     returns `{ path: tempPath, tempPath }`.
 *   - D-04 "for ANY reason" generation failure: if reading the overlay or writing
 *     the temp throws (ENOSPC, EACCES, EROFS, missing tmpdir, unreadable overlay,
 *     etc.), `warn` once and fall back to the BUNDLED base path so the scan STILL
 *     runs with the full bundled allowlist. Never returns `path: null` here, never
 *     throws, never skips. The `[extend]` `NomadFatal` (D-05) is thrown outside the
 *     fallback try, so it is never swallowed by this catch.
 *
 * @returns A `TomlConfigResult`; the caller passes `path` to `--config` (omitting
 *   the flag on `null`) and removes a non-null `tempPath` in a `finally`.
 */
export function resolveTomlConfig(): TomlConfigResult {
  const overlayPath = join(REPO_HOME, '.gitleaks.overlay.toml');
  const repoToml = join(REPO_HOME, '.gitleaks.toml');
  const bundled = resolveTomlPath();
  if (!existsSync(overlayPath)) {
    return { path: bundled, tempPath: null };
  }
  // S-01: a full REPO_HOME/.gitleaks.toml wins outright; resolveTomlPath returns
  // it before the bundled copy, so compare to detect that case and short-circuit
  // before generating a temp (keeps the chain at the safe depth-2 max).
  if (bundled === repoToml) {
    warn(
      '.gitleaks.overlay.toml ignored: REPO_HOME/.gitleaks.toml takes precedence (full manual control)',
    );
    return { path: bundled, tempPath: null };
  }
  // D-04: no bundled base to chain onto; run with the default ruleset, never skip.
  if (bundled === null) {
    return { path: null, tempPath: null };
  }
  // D-04: any overlay-read or temp-generation I/O failure falls back to the
  // bundled base so the scan still runs with the full bundled allowlist (never
  // null, never thrown). The overlay is read ONCE here and the same buffer is
  // both guarded and spliced, closing the guard-vs-build TOCTOU. The D-05
  // [extend] NomadFatal is re-thrown from the catch so it is never swallowed by
  // this fallback.
  try {
    const overlayBody = readFileSync(overlayPath, 'utf8');
    if (OVERLAY_EXTEND_RE.test(overlayBody)) {
      throw new NomadFatal(
        '.gitleaks.overlay.toml must not contain an [extend] block; it is generated automatically. Remove the [extend] section and retry.',
      );
    }
    const { configPath, tempPath } = buildOverlayTempConfig(overlayBody, bundled);
    return { path: configPath, tempPath };
  } catch (err) {
    if (err instanceof NomadFatal) throw err;
    warn(
      `.gitleaks.overlay.toml merge failed (${(err as Error).message}); falling back to the bundled allowlist`,
    );
    return { path: bundled, tempPath: null };
  }
}
