import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

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
import { claudeHome, HOST, NEVER_SYNC, repoHome, type PathMap } from './config.ts';
import {
  validateSharedDirEntry,
  type SharedDirRejectionReason,
} from './config.sharedDirs.guard.ts';
import {
  addChildItem,
  addItem,
  readJsonSafe,
  type DoctorSection,
} from './commands.doctor.format.ts';
import { encodePath, validatePathMapShape } from './utils.json.ts';

/**
 * Path-map reporters for `cmdDoctor`: the mapped-projects listing, the
 * path-encoding collision scan, and the never-sync visibility line. Each helper
 * appends items to its target `DoctorSection` and signals failure by setting
 * `process.exitCode = 1`. Read-only: FAIL lines stay on stdout.
 */

/** Emits the mapped-projects header for the current host and one nested child row per mapped project. */
function reportMappedProjects(section: DoctorSection, map: PathMap): void {
  const mapped = Object.entries(map.projects).filter(([, hosts]) => hosts[HOST]);
  addItem(section, `Mapped projects for ${cyan(HOST)}: ${dim(String(mapped.length))}`);
  for (const [name, hosts] of mapped) {
    addChildItem(section, `${name} -> ${blue(hosts[HOST])}`);
  }
}

/**
 * Emits the unmapped-projects header and one nested child row per local
 * `~/.claude/projects/<encoded>/` dir with no path-map entry for this host.
 * These are what `nomad push` reports as "N unmapped" (left alone in both
 * directions); listing them here closes the loop on the push summary's
 * "run nomad doctor to list" hint. Silent when every local dir is mapped or
 * the local projects dir does not exist.
 */
function reportUnmappedProjects(section: DoctorSection, map: PathMap): void {
  const localProjects = join(claudeHome(), 'projects');
  if (!existsSync(localProjects)) return;
  // Tolerant-doctor contract: an unreadable projects dir (permissions) skips
  // this informational listing instead of throwing mid-output.
  let localDirs: string[];
  try {
    localDirs = readdirSync(localProjects);
  } catch {
    return;
  }
  const mappedEncodings = new Set(
    Object.values(map.projects)
      .map((hosts) => hosts[HOST])
      .filter(Boolean)
      .map((abspath) => encodePath(abspath)),
  );
  const unmapped = localDirs.filter((dir) => !mappedEncodings.has(dir));
  if (unmapped.length === 0) return;
  addItem(section, `Unmapped local projects (not synced): ${dim(String(unmapped.length))}`);
  for (const dir of unmapped) {
    addChildItem(section, dim(dir));
  }
}

/**
 * Emits a WARN row for each path-map entry where the current host's local path
 * does not exist on disk. Skips entries for other hosts (legitimately absent on
 * this machine), TBD placeholders, and empty strings. Does not set
 * process.exitCode: a project may legitimately be cloned on only some hosts, so
 * a missing path is a nudge before a remap fails, not a hard failure.
 */
function reportCurrentHostPathsMissing(section: DoctorSection, map: PathMap): void {
  for (const [name, hosts] of Object.entries(map.projects)) {
    const abspath = hosts[HOST];
    if (!abspath || abspath === 'TBD') continue;
    if (!existsSync(abspath)) {
      addItem(
        section,
        `${yellow(warnGlyph)} path-map: ${name} local path missing on ${HOST}: ${blue(abspath)}`,
      );
    }
  }
}

/**
 * Report whether a rejected `sharedDirs` entry has a leftover copy under
 * `shared/` in the repo working tree.
 *
 * Tests the entry's own path rather than matching it against a listing, which
 * makes the filesystem answer the case question instead of this code guessing
 * at it. On macOS and NTFS a `Plans` entry finds a leftover stored as
 * `shared/plans`, because those names ARE one directory there, and the row's
 * `shared/Plans` is a path the user can act on. On a case-sensitive filesystem
 * they are two unrelated directories and this correctly finds nothing: matching
 * case-insensitively there would name a real but unrelated directory and tell
 * the user to delete it, which is worse than naming none.
 *
 * `lstat` rather than `existsSync`, so the final component is not followed: a
 * leftover stored as a symlink whose own target is gone is still a leftover the
 * user has to clear, and `existsSync` reports it absent. Wrapped and given
 * `throwIfNoEntry: false` so an absent, unreadable, or non-directory `shared/`
 * degrades to `false` and leaves the caller's rejection rows intact.
 *
 * The entry is safe to join: only reasons {@link isProbeableOnThisHost} admits
 * reach here, and every one has cleared `SAFE_SEGMENT` on a platform where the
 * name means what it says.
 *
 * @param entry - The rejected `sharedDirs` name to probe under `shared/`.
 * @returns `true` when `shared/<entry>` resolves on this filesystem.
 */
function hasSharedLeftover(entry: string): boolean {
  try {
    return lstatSync(join(repoHome(), 'shared', entry), { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

/**
 * The rejection reasons whose entries may be joined into a filesystem path by
 * the remediation probes below. An allow-list, not a deny-list on
 * `not-a-segment`: reaching any reason listed here proves `SAFE_SEGMENT`
 * already passed, so the name carries no path separator, `.` or `..`. A
 * `not-a-segment` entry may be `../escape`, and `join` normalizes `..`, so
 * probing one would stat a path outside `~/.claude/` and report the answer as
 * though it were about the configured name. Listing the safe reasons means a
 * future reason added before the segment check fails closed instead of
 * silently becoming probeable.
 *
 * `reserved` is deliberately NOT listed, even though it is path-safe. The
 * remediation rows exist for a name nomad no longer manages but this host
 * still has materialized. A reserved name is the opposite: it collides with
 * something nomad manages RIGHT NOW, so `~/.claude/commands` is a live symlink
 * into `shared/commands`, and the rows would tell the user to remove tracked
 * content that every other host syncs. There is also nothing to recover, since
 * the name is already synced under nomad's own management.
 */
const PROBABLE_REASONS: ReadonlySet<SharedDirRejectionReason> = new Set([
  'never-sync',
  'secret-shaped',
]);

/**
 * Whether a rejected entry may be joined into a path and probed on THIS host.
 *
 * Keyed on the entry's SPELLING, not on its rejection cause. The aliasing is a
 * property of the trailing dot itself, and the cause now describes the name
 * win32 would address rather than the one written, so a cause-based test stops
 * covering these the moment the guard starts resolving them: `commands.`
 * reports `reserved` and `.env.` reports `secret-shaped`, and neither is
 * `win32-alias` any more.
 *
 * On win32 the trailing dots are stripped, so the string addresses a DIFFERENT
 * path than it names: `mytools.` resolves to `shared/mytools`, `commands.` to
 * the live tracked `shared/commands`, and `...` to `shared/` itself, which is
 * precisely the escape this allow-list exists to prevent (and which slips past
 * the `.`/`..` test because it is neither). Never probe one there.
 *
 * On posix such a name is an ordinary distinct directory that aliases nothing,
 * so it is always probeable regardless of the cause it inherited: the inherited
 * cause describes a file this platform does not resolve it to.
 *
 * @param entry - The rejected `sharedDirs` entry, as written.
 * @param reason - The rejection cause reported for it.
 * @returns `true` when the entry is safe to join and probe here.
 */
function isProbeableOnThisHost(entry: string, reason: SharedDirRejectionReason): boolean {
  if (entry.endsWith('.')) return process.platform !== 'win32';
  return PROBABLE_REASONS.has(reason);
}

/**
 * Classify `~/.claude/<entry>`: a symlink resolving into the repo's `shared/`
 * tree (the state an older, looser guard leaves behind after `nomad adopt`
 * moved that name into `shared/`), a symlink pointing anywhere else, or
 * neither.
 *
 * The target is resolved rather than assumed. A user may have their own
 * symlink at that name (`~/.claude/credentials -> ~/.password-store`) and a
 * matching `sharedDirs` entry; telling them to "remove both" would then point
 * at content nomad never owned. `cmdEject` already treats this exact state as
 * real and guards it with the same containment test, so resolving here keeps
 * the two commands agreeing about the same directory.
 *
 * Containment uses a trailing-separator prefix test, so a sibling
 * `shared-other/` is not read as a child of `shared/`.
 *
 * A link whose target cannot be resolved is `'dangling'`, NOT `'absent'`, and
 * that distinction is load-bearing. Whether the link resolves and whether
 * `shared/<entry>` exists are INDEPENDENT facts: the listing comes from its own
 * `readdirSync`. So a link left over from a moved checkout can dangle while
 * `shared/<entry>` under the current root holds the user's only copy, and
 * collapsing dangling into absent would hand that state the delete-it-by-hand
 * row. Follows the tolerant-doctor contract otherwise: an absent path, an
 * unreadable parent, or a path component that is not a directory degrade to
 * `'absent'` instead of throwing mid-output.
 *
 * @param entry - The rejected `sharedDirs` name to probe under `~/.claude/`.
 * @returns `'managed'` for a link into `shared/`, `'foreign'` for a link
 *   elsewhere, `'dangling'` for a link whose target will not resolve,
 *   `'absent'` when there is no symlink to classify.
 */
function classifyLocalLink(entry: string): 'managed' | 'foreign' | 'dangling' | 'absent' {
  const linkPath = join(claudeHome(), entry);
  let stat;
  try {
    stat = lstatSync(linkPath, { throwIfNoEntry: false });
  } catch {
    return 'absent';
  }
  if (stat?.isSymbolicLink() !== true) return 'absent';

  let target: string;
  try {
    target = realpathSync(linkPath);
  } catch {
    // The LINK is what will not resolve. Terminal, and recommends removing
    // nothing, since a copy under shared/ may be all that is left.
    return 'dangling';
  }

  // Resolved on BOTH sides. Comparing a resolved target against a raw root
  // misreads every managed link on a host whose repo path runs through a
  // symlink (macOS /tmp and /var/folders, a symlinked $HOME, NOMAD_REPO via a
  // link): the prefix test fails, the link is called foreign, and foreign is
  // not terminal, so the delete row then names the user's only copy.
  // `cmdEject` resolves its root for the same reason.
  let root: string;
  try {
    root = realpathSync(join(repoHome(), 'shared'));
  } catch {
    // Separate from the link's own failure on purpose. The link resolves fine
    // here; it is `shared/` that is absent, and a link cannot be contained by a
    // directory that does not exist. Reporting this as dangling would tell the
    // user a live link is dead and invite them to remove it.
    return 'foreign';
  }
  return target.startsWith(root + sep) ? 'managed' : 'foreign';
}

/**
 * Emits a top-level WARN row for every rejected `sharedDirs` entry in
 * `path-map.json`, naming the entry and the specific reason
 * {@link validateSharedDirEntry} gave. Rows are pushed as top-level items,
 * never as nested children: `compactSections` keeps a row by its WARN glyph
 * alone, so a child row survives into the compact view while the passing
 * parent it belonged under does not. `renderChildLine` then attaches its
 * connector to whatever row happens to precede it, and the rejection reads as
 * subordinate to an unrelated entry. Never sets `process.exitCode`, since the
 * condition already fails closed at the push gate and this row is
 * informational, not a failure.
 *
 * For any rejected entry this host may still have materialized, also emits a
 * remediation row, but only for the reasons in {@link PROBABLE_REASONS}: those
 * are the ones the guard tests after its single-segment check, so the name is
 * known separator-free before it reaches a `join`. A symlink at
 * `~/.claude/<entry>` that resolves INTO `shared/` leads with copying the
 * content out and only then removing both: telling the user to delete the
 * repo-side path on its own would destroy the only copy and leave a dangling
 * link behind. A symlink resolving anywhere else is someone else's, so that row
 * says to leave it alone; the name is still checked for a repo-side leftover,
 * since an unrelated link shadowing the name must not suppress that. With no
 * symlink at all, a leftover directly under `shared/` (from before this guard
 * existed) gets the plain remove-it-by-hand row. Nomad never deletes any of
 * them.
 *
 * Every row escapes the entry with `JSON.stringify`. `path-map.json` is a
 * trust boundary and a POSIX filename may carry control or ANSI escape bytes,
 * so an unescaped interpolation lets a crafted name rewrite the WARN rows
 * around it. The remediation rows are reachable only when the on-disk name
 * matches the configured one, which puts both halves under the same control.
 *
 * Tolerates a malformed `sharedDirs` (a non-array, or members that are not
 * strings), which `validatePathMapShape` deliberately leaves unchecked. A
 * present-but-non-array value gets its own row and stops the scan there,
 * matching what `allSharedLinks` does with the same input: iterating it would
 * either throw and abort the whole doctor run (a number is not iterable) or
 * walk a string character by character and report one row per character.
 *
 * @param section - The doctor "Path map" section to append rows to.
 * @param map - Parsed `path-map.json` content.
 */
function reportRejectedSharedDirs(section: DoctorSection, map: PathMap): void {
  const raw: unknown = map.sharedDirs;
  if (raw !== undefined && !Array.isArray(raw)) {
    addItem(
      section,
      `${yellow(warnGlyph)} path-map: sharedDirs is not an array (${typeof raw}); the whole field is ignored`,
    );
    return;
  }
  const entries: unknown[] = Array.isArray(raw) ? raw : [];
  const probable: string[] = [];
  for (const entry of entries) {
    const rejection = validateSharedDirEntry(entry);
    if (rejection === null) continue;
    if (typeof entry === 'string' && isProbeableOnThisHost(entry, rejection.reason)) {
      probable.push(entry);
    }
    addItem(
      section,
      `${yellow(warnGlyph)} path-map: sharedDirs entry ${JSON.stringify(entry)} rejected: ${rejection.message}; skipping`,
    );
  }
  reportRejectedLeftovers(section, probable);
}

/**
 * Emit the remediation rows for rejected entries this host may still have
 * materialized. Split out of {@link reportRejectedSharedDirs} to keep both
 * under the cognitive-complexity gate; the seam is the natural one, since the
 * caller decides WHICH entries are probeable and this decides what to say
 * about each.
 *
 * A managed link (resolving into `shared/`) is terminal: its row already tells
 * the user to remove the repo side, so adding the leftover row would double up.
 * A dangling link is terminal for the opposite reason: nothing about it is
 * safe to delete yet, so it must not fall through to a row that says remove.
 * A foreign link is someone else's, and the repo-side leftover under the same
 * name is an independent fact, so those two rows may fire together.
 *
 * @param section - The doctor "Path map" section to append rows to.
 * @param probable - Rejected entries whose reason makes them safe to join into
 *   a path (see {@link PROBABLE_REASONS}).
 */
function reportRejectedLeftovers(section: DoctorSection, probable: string[]): void {
  for (const entry of probable) {
    const link = classifyLocalLink(entry);
    if (link === 'managed') {
      addItem(
        section,
        `${yellow(warnGlyph)} path-map: entry ${JSON.stringify(entry)} is a symlink under ~/.claude/ ` +
          `pointing into shared/; copy the content out first (cp -RL), then remove both. ` +
          `nomad will not do it for you`,
      );
      continue;
    }
    if (link === 'dangling') {
      addItem(
        section,
        `${yellow(warnGlyph)} path-map: entry ${JSON.stringify(entry)} is a DANGLING symlink under ~/.claude/ ` +
          `(its target does not resolve); do not delete anything under shared/ yet, since a copy there ` +
          `may be the only one left. nomad cannot restore this name, because the entry is refused: ` +
          `recover the content by hand if you need it, then remove the dead link`,
      );
      continue;
    }
    if (link === 'foreign') {
      addItem(
        section,
        `${yellow(warnGlyph)} path-map: entry ${JSON.stringify(entry)} is a symlink under ~/.claude/ ` +
          `pointing OUTSIDE shared/; nomad does not manage it, so leave it alone and just drop the ` +
          `entry from sharedDirs`,
      );
    }
    if (hasSharedLeftover(entry)) {
      addItem(
        section,
        `${yellow(warnGlyph)} path-map: shared/ entry ${JSON.stringify(entry)} exists in the repo working tree; remove it by hand, nomad will not delete it`,
      );
    }
  }
}

/** Scans every host of every project for encodePath collisions; emits failGlyph per collision (sets exitCode=1), okGlyph when clean. */
function reportPathCollisions(section: DoctorSection, map: PathMap): void {
  const seen = new Map<string, string>();
  let collisionCount = 0;
  for (const hosts of Object.values(map.projects)) {
    for (const abspath of Object.values(hosts)) {
      if (!abspath || abspath === 'TBD') continue;
      const encoded = encodePath(abspath);
      const prior = seen.get(encoded);
      if (prior !== undefined && prior !== abspath) {
        addItem(
          section,
          `${red(failGlyph)} path-encoding collision: ${prior} and ${abspath} both encode to ${encoded}`,
        );
        collisionCount++;
      } else {
        seen.set(encoded, abspath);
      }
    }
  }
  if (collisionCount > 0) process.exitCode = 1;
  else addItem(section, `${green(okGlyph)} path-encoding: no collisions`);
}

/** Pushes mapped projects for the current host and FAILs on path-encoding collisions across hosts; FAILs when path-map.json is missing. */
export function reportPathMap(section: DoctorSection): void {
  const mapPath = join(repoHome(), 'path-map.json');
  if (!existsSync(mapPath)) {
    addItem(section, `${red(failGlyph)} path-map.json missing at ${blue(mapPath)}`);
    process.exitCode = 1;
    return;
  }
  const map = readJsonSafe<PathMap>(mapPath, mapPath, section);
  if (map === null) return;
  // Guard non-object `projects` and per-project non-object `hosts` so the
  // helpers' `hosts[HOST]` / `Object.values(hosts)` cannot throw mid-output and
  // break the tolerant-doctor contract. Shares the shape walk with `readPathMap`
  // and `resume.ts` via `validatePathMapShape` for one uniform error vocabulary.
  const shapeError = validatePathMapShape(map);
  if (shapeError !== null) {
    addItem(section, `${red(failGlyph)} ${shapeError}`);
    process.exitCode = 1;
    return;
  }
  reportMappedProjects(section, map);
  reportCurrentHostPathsMissing(section, map);
  reportRejectedSharedDirs(section, map);
  reportUnmappedProjects(section, map);
  reportPathCollisions(section, map);
}

/** Pushes a one-line NEVER_SYNC count with a docs pointer; the full static list is config, not diagnosis. */
export function reportNeverSync(section: DoctorSection): void {
  addItem(
    section,
    `${dim(infoGlyph)} never-sync items: ${NEVER_SYNC.size} protected ${dim(
      '(https://funkadelic.github.io/claude-nomad/how-it-works/)',
    )}`,
  );
}
