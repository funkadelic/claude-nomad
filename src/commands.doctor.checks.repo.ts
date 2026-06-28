import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  blue,
  cyan,
  dim,
  failGlyph,
  green,
  infoGlyph,
  okGlyph,
  red,
  warnGlyph,
  yellow,
} from './color.ts';
import {
  allSharedLinks,
  claudeHome,
  GSD_DROPPED_NAMES,
  HOST,
  repoHome,
  type PathMap,
} from './config.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { classifyRepoState, reasonForPartial } from './init.classify.ts';
import { readJson, validatePathMapShape } from './utils.json.ts';

/**
 * Host- and repo-state reporters for `cmdDoctor`. Each helper appends one or
 * more items to its target `DoctorSection` (via `addItem`) and signals failure
 * by setting `process.exitCode = 1`. Items go to stdout at render time through
 * `renderDoctor` in `commands.doctor.format`; nothing here writes to stderr
 * (read-only doctor contract: FAIL lines stay on stdout so a piped
 * `nomad doctor 2>/dev/null` does not lose them).
 */

/**
 * True when the `NOMAD_REPO` env override is set to a non-empty value.
 * Mirrors the `||` empty-string-fallthrough semantics of `REPO_HOME` itself
 * (see `src/config.ts`): an unset env, or `export NOMAD_REPO=`, both return
 * false because the default fallback fires. Reads `process.env.NOMAD_REPO`
 * directly so a set-but-empty value is distinguishable from "set to the
 * default path"; reading via the imported `REPO_HOME` constant cannot make
 * that distinction. Module-private helper for `reportRepoState`.
 */
function isOverrideActive(): boolean {
  return Boolean(process.env.NOMAD_REPO);
}

/**
 * Pushes the host identity (info), any app-specific env overrides the user
 * has set (`NOMAD_REPO`; `NOMAD_HOST` itself heads the section), and the two
 * key path lines (repo and claude-home) with gutter glyphs. Path presence is
 * reported via warnGlyph (not failGlyph) so an absent CLAUDE_HOME does not
 * flip sectionFailed to decorate the Host header with a fail glyph. The
 * authoritative empty-repo FAIL is owned by reportRepoState; these lines
 * remain informational and do NOT mutate process.exitCode.
 */
export function reportHostAndPaths(section: DoctorSection): void {
  // HOST already folds in the fallback (see src/config.ts); the unset hint
  // tells the user the value came from the OS hostname, not their shell rc.
  const unsetHint = process.env.NOMAD_HOST ? '' : dim(' (env unset, using hostname)');
  const repo = repoHome();
  const claude = claudeHome();
  addItem(section, `${dim(infoGlyph)} NOMAD_HOST: ${cyan(HOST)}${unsetHint}`);
  if (isOverrideActive()) {
    addItem(section, `${dim(infoGlyph)} NOMAD_REPO: ${blue(repo)}`);
  }
  addItem(section, `${existsSync(repo) ? green(okGlyph) : yellow(warnGlyph)} repo: ${blue(repo)}`);
  addItem(
    section,
    `${existsSync(claude) ? green(okGlyph) : yellow(warnGlyph)} claude home: ${blue(claude)}`,
  );
}

/**
 * The set of host keys referenced across every project in `path-map.json`.
 * Tolerant: a missing, unreadable, or malformed map yields an empty set rather
 * than throwing, since the authoritative path-map diagnostics live in the Path
 * map section. Module-private helper for `reportHostKeyAlignment`.
 */
function pathMapHostKeys(): Set<string> {
  const mapPath = join(repoHome(), 'path-map.json');
  if (!existsSync(mapPath)) return new Set();
  let raw: unknown;
  try {
    raw = readJson<unknown>(mapPath);
  } catch {
    return new Set();
  }
  if (validatePathMapShape(raw) !== null) return new Set();
  const keys = new Set<string>();
  for (const hosts of Object.values((raw as PathMap).projects)) {
    for (const key of Object.keys(hosts)) keys.add(key);
  }
  return keys;
}

/**
 * The set of host labels that have a `hosts/<label>.json` override file.
 * Tolerant: an absent or unreadable `hosts/` directory yields an empty set.
 * Module-private helper for `reportHostKeyAlignment`.
 */
function hostOverrideLabels(): Set<string> {
  let entries: string[];
  try {
    entries = readdirSync(join(repoHome(), 'hosts'));
  } catch {
    return new Set();
  }
  const labels = new Set<string>();
  for (const entry of entries) {
    if (entry.endsWith('.json')) labels.add(entry.slice(0, -'.json'.length));
  }
  return labels;
}

/**
 * WARN when `NOMAD_HOST` is unset and the hostname-derived HOST key is not
 * recognized in a repo that is demonstrably multi-host. HOST is the join key
 * that selects the per-host settings override and keys every path-map session
 * mapping. The warning fires only when ALL of:
 *   - `NOMAD_HOST` is unset (so the key came from `os.hostname()`, not a label
 *     the user chose),
 *   - this host has neither a `hosts/<HOST>.json` override nor any path-map
 *     entry (presence of the key, not a truthy value: an empty or `TBD`
 *     placeholder still counts as recognized),
 *   - and the repo configures at least one OTHER host (an override file or a
 *     path-map entry under a different label).
 * The last condition is the narrowing: a single-host or fresh repo stays silent,
 * so the warning surfaces only a genuine cross-host misalignment (a second host
 * that forgot to `export NOMAD_HOST`, whose hostname key lines up with nothing
 * the other hosts use). Informational only: never sets `process.exitCode`.
 */
export function reportHostKeyAlignment(section: DoctorSection): void {
  if (process.env.NOMAD_HOST) return;
  const overrideLabels = hostOverrideLabels();
  const mapKeys = pathMapHostKeys();
  // Recognized here means this host has a per-host override or a path-map entry.
  if (overrideLabels.has(HOST) || mapKeys.has(HOST)) return;
  // Neither set contains HOST at this point, so any remaining entry is another
  // host. Stay silent on a single-host or fresh repo; only nag when the repo
  // already configures some other host, which makes this host's unrecognized
  // key a real misalignment.
  if (overrideLabels.size === 0 && mapKeys.size === 0) return;
  addItem(
    section,
    `${yellow(warnGlyph)} NOMAD_HOST unset: this repo configures other hosts, but the hostname key ${cyan(HOST)} matches no hosts/${HOST}.json or path-map entry; set NOMAD_HOST to the label this host should use so per-host settings and session sync line up`,
  );
}

/** Emits the repo-state status line derived from classifyRepoState (okGlyph/warnGlyph/failGlyph). When `NOMAD_REPO` is active, all three branches receive a ` (NOMAD_REPO)` suffix so the env override is visible whatever the repo state. FAIL signals via process.exitCode. */
export function reportRepoState(section: DoctorSection): void {
  const repo = repoHome();
  const state = classifyRepoState(repo, HOST);
  // Computed once so populated/partial/empty branches share the same
  // annotation. Leading space before `(` keeps the line readable on every
  // branch; empty string produces zero visual change when the override is
  // not in play, matching SPEC §5 (acceptance: unset env -> no annotation).
  const overrideLabel = isOverrideActive() ? ' (NOMAD_REPO)' : '';
  if (state === 'populated') {
    addItem(section, `${green(okGlyph)} repo state: populated${overrideLabel}`);
  } else if (state === 'partial') {
    addItem(
      section,
      `${yellow(warnGlyph)} repo state: partial ${reasonForPartial(repo, HOST)}${overrideLabel}`,
    );
  } else {
    addItem(
      section,
      `${red(failGlyph)} repo state: empty - run 'nomad init' to scaffold${overrideLabel}`,
    );
    process.exitCode = 1;
  }
}

/**
 * True when the repo has a `shared/<name>` source for this link. `applySharedLinks`
 * only creates a symlink when this source exists, so when it does NOT, an absent
 * or dangling link in `~/.claude/` is expected (nothing to sync), not a problem to
 * fix. Doctor uses this to downgrade those rows from a warn to an info note.
 */
function repoHasSharedSource(name: string): boolean {
  return existsSync(join(repoHome(), 'shared', name));
}

/**
 * Resolve the display item and optional exit-code side-effect for a single
 * shared-link path. Returns `{ line, fail }` where `fail` true means the
 * caller should set `process.exitCode = 1`.
 *
 * Extracted from `reportSharedLinks` to reduce cognitive complexity: the lstat
 * try/catch and the inner symlink-target try/catch each count against the
 * parent function's score.
 */
function classifySharedLink(name: string, p: string): { line: string; fail: boolean } {
  let stat;
  try {
    stat = lstatSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return repoHasSharedSource(name)
        ? {
            line: `${yellow(warnGlyph)} ${name}: missing (run \`nomad pull\` to restore)`,
            fail: false,
          }
        : { line: `${dim(infoGlyph)} ${name}: not synced (nothing in shared/)`, fail: false };
    }
    return { line: `${red(failGlyph)} ${name}: could not stat (${String(code)})`, fail: true };
  }
  if (!stat.isSymbolicLink()) {
    return {
      line: `${red(failGlyph)} ${name}: NOT a symlink (blocks sync); run \`nomad adopt ${name}\` to fix`,
      fail: true,
    };
  }
  return classifySymlinkTarget(name, p);
}

/**
 * Resolve the display item for a path already confirmed to be a symlink.
 * Follows the link via statSync; a throw means the target is missing or
 * unreadable. Never FAILs (`fail: false`): a dangling link whose source still
 * lives in the repo is a WARN with a `nomad pull` hint, a dangling link whose
 * source is gone from the repo is an info note (stale, safe to remove), and a
 * non-ENOENT stat error is a WARN naming the code.
 */
function classifySymlinkTarget(name: string, p: string): { line: string; fail: boolean } {
  try {
    statSync(p);
    return { line: `${green(okGlyph)} ${name}: symlink`, fail: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return repoHasSharedSource(name)
        ? {
            line: `${yellow(warnGlyph)} ${name}: broken symlink (target missing, run \`nomad pull\`)`,
            fail: false,
          }
        : {
            line: `${dim(infoGlyph)} ${name}: stale symlink (no longer in shared/, safe to remove)`,
            fail: false,
          };
    }
    return {
      line: `${yellow(warnGlyph)} ${name}: symlink target unreadable (${String(code)})`,
      fail: false,
    };
  }
}

/**
 * Emits a per-entry status line for each name in `allSharedLinks(map)` (the
 * static shared-link set plus any validated `sharedDirs` entries) using
 * okGlyph/warnGlyph/infoGlyph/failGlyph. A non-symlink blocks sync and FAILs
 * via process.exitCode. TOCTOU-safe: lstatSync is wrapped in try/catch so a path
 * that vanishes or becomes unreadable between the probe and the stat yields a
 * row instead of an unhandled throw that aborts the whole doctor run. Severity
 * keys off whether the repo still has a `shared/<name>` source: an absent or
 * dangling link is a WARN with a `nomad pull` hint when the source exists (a
 * real out-of-sync state), and a calm info note when it does not (nothing to
 * sync). A symlink whose target cannot be resolved is never a healthy OK, so a
 * dangling or unreadable link is not masked.
 */
export function reportSharedLinks(section: DoctorSection, map: PathMap): void {
  const claude = claudeHome();
  for (const name of allSharedLinks(map)) {
    const p = join(claude, name);
    const { line, fail } = classifySharedLink(name, p);
    addItem(section, line);
    if (fail) process.exitCode = 1;
  }
}

/**
 * Non-destructive migration probe for dirs that were dropped from SHARED_LINKS.
 * For each name in GSD_DROPPED_NAMES, lstat `~/.claude/<name>`: if the path
 * exists AND is a symbolic link (leftover from the old symlink era), emit a
 * WARN/info migration hint telling the user to remove the symlink and let gsd
 * reinstall a real dir. Does NOT set process.exitCode (this is migration
 * guidance, not a FAIL). Emits nothing when the name is absent, is a real
 * directory, or is any non-symlink path (migration already done or never applied).
 *
 * The probe intentionally does NOT key off repoHasSharedSource: the repo trees
 * for hooks/agents are left in place as inert history (D-4 part 4), so
 * repoHasSharedSource stays true. Reusing classifySymlinkTarget would render a
 * healthy "ok <name>: symlink" line instead of migration guidance.
 */
export function reportDroppedNamesMigration(section: DoctorSection): void {
  const claude = claudeHome();
  for (const name of GSD_DROPPED_NAMES) {
    const p = join(claude, name);
    let stat;
    try {
      stat = lstatSync(p);
    } catch {
      continue; // absent or unreadable: no leftover symlink, nothing to emit
    }
    if (!stat.isSymbolicLink()) continue; // real dir (gsd already owns it)
    addItem(
      section,
      `${yellow(warnGlyph)} ${name}: gsd now owns this dir per-host (was a nomad symlink); ` +
        `run \`rm ~/.claude/${name}\` and let gsd reinstall a real dir`,
    );
  }
}
