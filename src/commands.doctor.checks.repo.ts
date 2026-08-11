import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { join, win32 as win32Path } from 'node:path';

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
  deniedSegmentFor,
  GSD_DROPPED_NAMES,
  HOST,
  repoHome,
  type PathMap,
} from './config.ts';
import { addChildItem, addItem, type DoctorSection } from './commands.doctor.format.ts';
import { listDivergingFiles } from './extras-sync.diff.ts';
import { classifyRepoState, reasonForPartial } from './init.classify.ts';
import { readJson, validatePathMapShape } from './utils.json.ts';

/**
 * Host- and repo-state reporters for `cmdDoctor`. Each helper appends one or
 * more items to its target `DoctorSection` (via `addItem`) and signals failure
 * by setting `process.exitCode = 1`. Items go to stdout at render time through
 * `renderDoctor` in `commands.doctor.format`; every status line stays on stdout
 * (read-only doctor contract: FAIL lines must survive a piped
 * `nomad doctor 2>/dev/null`). The one stderr write reachable from this file is
 * the WARN `listDivergingFiles` emits when git is missing from PATH or the
 * compare fails, which is skip-reporting rather than a status line and matches
 * what `reportSkillsDivergence` already does.
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

/** Return shape shared by every `classifySharedLink` branch. */
type SharedLinkClassification = { line: string; fail: boolean; children?: string[] };

/**
 * The unconditional win32 copy-sync healthy row, reused by every OK case below.
 *
 * `exempt` counts diverging paths the compare threw out as never-synced, and is
 * named in a dim trailing note when non-zero. Which paths is deliberately left
 * unsaid (they are never-synced by definition, so naming them is not
 * actionable), but a bare OK row with a standing one-way divergence behind it
 * reads as "nothing to see" when the truth is "nothing this tool will ever
 * reconcile". Never a WARN, because no command could clear it; compact mode
 * strips passing rows either way, so this surfaces under `--verbose`, where a
 * reader is asking for detail.
 */
function win32CopyOkRow(name: string, exempt = 0): SharedLinkClassification {
  const note = exempt > 0 ? dim(` (${exempt} never-synced path(s) not compared)`) : '';
  return { line: `${green(okGlyph)} ${name}: real copy (win32 copy-sync)${note}`, fail: false };
}

/**
 * The path from `root` down to `path`, forward-slashed, or `null` when `path`
 * is not strictly under `root`.
 *
 * Takes its path semantics from `path.win32` rather than from the host, because
 * this is reached only from `classifyWin32Copy` and the platform's own rules are
 * what make the out-of-tree cases expressible at all: `relative` across two
 * drive letters returns the destination verbatim and ABSOLUTE rather than a
 * `..` walk, so a `..` test alone reads a `D:\...` path as contained. Splicing
 * that after the `shared/<name>/` prefix would hand `deniedSegmentFor` every
 * segment of the REPO's own location, and a sync repo living under, say,
 * `D:\sessions\` would exempt every repo-only file on the host. Reading the
 * semantics from the module also lets the suite exercise the case on any host.
 *
 * An empty result means `path` IS `root`, which is what git reports for a
 * file-type shared name (`CLAUDE.md`, `my-statusline.cjs`): the file is its own
 * compare root, so there is no segment below it to return.
 *
 * @param root - One of the two absolute compare roots.
 * @param path - An absolute path taken from a `--name-status` record.
 * @returns The contained relative path, or `null` when there is none.
 */
function relativeUnder(root: string, path: string): string | null {
  const rel = win32Path.relative(root, path);
  const segments = rel.split(win32Path.sep);
  if (rel === '' || segments[0] === '..' || win32Path.isAbsolute(rel)) return null;
  return segments.join('/');
}

/**
 * One `listDivergingFiles` line rewritten as the repo-relative, forward-slashed
 * path `shared/<name>/<rest>`, which is the shape `deniedSegmentFor` expects:
 * it picks its denylist from the first two segments, so a bare relative path
 * would be classified as if it sat somewhere else in the tree.
 *
 * The `(local only)` / `(repo only)` side indicator is stripped first, matching
 * the exact suffixes `labelEntry` produces in `extras-sync.diff.ts`. git
 * reports a modified or local-only file under the local root and a repo-only
 * file under the repo root, so the path is relativized against whichever of the
 * two contains it, and against neither when it is contained by neither. That
 * last case yields the bare `shared/<name>`, which no denylist holds, so a path
 * this function cannot place is never exempted (see {@link relativeUnder} for
 * the two shapes that reach it).
 *
 * @param line - One line from `listDivergingFiles`.
 * @param name - The shared name being compared (`commands`, `rules`, ...).
 * @param local - Absolute `~/.claude/<name>` path passed to the compare.
 * @param shared - Absolute `shared/<name>` path passed to the compare.
 * @returns The repo-relative path, ready for `deniedSegmentFor`.
 */
function divergingRepoPath(line: string, name: string, local: string, shared: string): string {
  const path = line.replace(/ \((?:local|repo) only\)$/, '');
  const rel = relativeUnder(local, path) ?? relativeUnder(shared, path);
  return rel === null ? `shared/${name}` : `shared/${name}/${rel}`;
}

/**
 * Win32 branch of `classifySharedLink`'s non-symlink case: the real (copied)
 * file/dir at `p` is the healthy state there, but a healthy PRESENCE is not
 * the same as a healthy CONTENT. With capture-on-pull in place (see
 * `links.mirror.ts`, `links.deletions.ts`), a standing byte-level
 * divergence from `shared/<name>` means something did not reconcile, which is
 * worth a nudge before the next mutating command runs.
 *
 * Skips the compare entirely when the repo has no `shared/<name>` source:
 * there is nothing to compare against, and the row stays the plain OK line.
 * The presence probe is inlined rather than delegated to `repoHasSharedSource`
 * so the repo path it builds is computed once and reused as the compare's
 * right-hand side. The compare itself routes through
 * `listDivergingFiles`, the same byte-level `git diff --no-index` helper
 * `reportSkillsDivergence` already uses (never mtime-based, so a checkout
 * mtime rewrite cannot manufacture a false WARN), which never throws and
 * WARNs (rather than raising) when git is absent from PATH. Divergence is
 * always a WARN, never a FAIL: `process.exitCode` is left untouched exactly
 * like `reportSkillsDivergence`, per the doctor reporter contract.
 *
 * The compare's result is filtered through `deniedSegmentFor`, the same
 * predicate the host-to-repo mirror applies at copy time (`mirrorOneSharedName`
 * in `links.mirror.ts`). A path under a shared name that the predicate rejects
 * exists locally by design and is deliberately never copied into the repo, so
 * counting it as drift would produce a WARN on every run that no command could
 * clear, which is worse than no WARN at all. The test has to run over every
 * segment rather than the basename, because that denylist holds ordinary
 * DIRECTORY names (`sessions`, `tasks`, `plans`, ...) as well as filenames, and
 * a denied directory segment is structurally invisible to a basename test.
 *
 * What the exemption costs is a signal, and the count is given back rather than
 * swallowed. Such a path is a genuine, permanent one-way divergence: the mirror
 * will never copy it, and the pull is silent about it by design, so with the
 * exemption in place no surface reports it at all. The row still reads OK,
 * because no command can clear it, but it says how many there were; see
 * {@link exemptNote}.
 *
 * Extracted out of `classifySharedLink` so adding this compare does not push
 * that already branch-dense function over the cognitive-complexity gate.
 */
function classifyWin32Copy(name: string, p: string): SharedLinkClassification {
  const sharedPath = join(repoHome(), 'shared', name);
  if (!existsSync(sharedPath)) return win32CopyOkRow(name);
  const compared = listDivergingFiles(p, sharedPath);
  const diverging = compared.filter(
    (line) => deniedSegmentFor(divergingRepoPath(line, name, p, sharedPath)) === null,
  );
  const exempt = compared.length - diverging.length;
  if (diverging.length === 0) return win32CopyOkRow(name, exempt);
  return {
    line: `${yellow(warnGlyph)} ${name}: ${diverging.length} file(s) diverge from shared/${name}`,
    fail: false,
    children: diverging,
  };
}

/**
 * Resolve the display item and optional exit-code side-effect for a single
 * shared-link path. Returns `{ line, fail, children }` where `fail` true
 * means the caller should set `process.exitCode = 1`, and `children` (when
 * present) is one child row per diverging file for the caller to render via
 * `addChildItem`. The classifier stays pure: it never touches the section
 * itself, so `reportSharedLinks` owns every `addItem`/`addChildItem` call.
 *
 * A non-symlink is the copy-sync model's healthy state on win32 (no
 * unprivileged symlink support there); see `classifyWin32Copy` for what
 * "healthy" means there now that a content compare is in play. On every
 * other platform a non-symlink still blocks sync and FAILs, unchanged.
 *
 * Extracted from `reportSharedLinks` to reduce cognitive complexity: the lstat
 * try/catch and the inner symlink-target try/catch each count against the
 * parent function's score.
 */
function classifySharedLink(name: string, p: string): SharedLinkClassification {
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
    if (process.platform === 'win32') {
      return classifyWin32Copy(name, p);
    }
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
 * dangling or unreadable link is not masked. On win32, a real copy that has
 * drifted in content from `shared/<name>` renders a WARN with the diverging
 * files as child rows (see `classifyWin32Copy`), instead of the unconditional
 * OK the copy-sync model used to report for any non-symlink.
 */
export function reportSharedLinks(section: DoctorSection, map: PathMap): void {
  const claude = claudeHome();
  // quiet: reportRejectedSharedDirs owns the user-facing text for a rejected
  // entry, in-tree and counted by the verdict.
  for (const name of allSharedLinks(map, { quiet: true })) {
    const p = join(claude, name);
    const { line, fail, children } = classifySharedLink(name, p);
    addItem(section, line);
    if (fail) process.exitCode = 1;
    if (children) {
      for (const child of children) addChildItem(section, child);
    }
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
 * for hooks/agents are left in place as inert history, so repoHasSharedSource
 * stays true. Reusing classifySymlinkTarget would render a
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
