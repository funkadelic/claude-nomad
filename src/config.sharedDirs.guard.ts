import { isSecretFileName, NEVER_SYNC } from './config.never-sync.ts';
import { NomadFatal } from './utils.ts';

/**
 * `logical` keys in `path-map.json` are project identifiers (e.g. `ha-acwd`,
 * `foo`), never path fragments. A crafted key like `../escape` or `foo/bar`
 * would escape `shared/projects/` (or `shared/extras/`) via `join()` (which
 * normalizes `..`) and land content somewhere unexpected on the filesystem.
 * The push allow-list catches such commits at the `git add` boundary, but the
 * filesystem mutation has already happened by then. This check fails fast
 * before any write. The pattern matches what every reasonable project name
 * looks like and rejects everything else.
 */
const SAFE_LOGICAL = /^[A-Za-z0-9._-]+$/;

/**
 * Throw `NomadFatal` unless `logical` is a path-separator-free project
 * identifier (see `SAFE_LOGICAL`). Path-traversal defense-in-depth; called
 * before any filesystem mutation by every remap and extras op that joins
 * `logical` into a filesystem path.
 *
 * @param logical - A `path-map.json` projects key to validate.
 */
export function assertSafeLogical(logical: string): void {
  if (!SAFE_LOGICAL.test(logical) || logical === '.' || logical === '..') {
    throw new NomadFatal(
      `invalid logical name in path-map.json: ${JSON.stringify(logical)} (must match [A-Za-z0-9._-]+; no path separators or '..')`,
    );
  }
}

/**
 * Single-segment path characters allowed in a `sharedDirs` entry. Mirrors
 * `SAFE_LOGICAL` above but applied to global support directory names rather
 * than per-project logical names. Must match `^[A-Za-z0-9._-]+$` so no path
 * separator and no shell-special character reach the filesystem join. This is
 * a character and separator test only: it does not reject a credential-shaped
 * name (`.env` matches the pattern), which is a separate later check.
 *
 * This pattern says nothing about trailing dots; the caller owns them. Win32
 * strips trailing dots off a path's final component, so `.env.` and
 * `settings.local.json.` address the same files as `.env` and
 * `settings.local.json` while matching none of the name checks below.
 * {@link validateSharedDirEntry} therefore normalizes first and classifies
 * the name the host addresses, so each spelling reports the cause describing
 * what it actually reaches. A bare trailing dot remains a rejection in its
 * own right, `win32-alias`, but only as the residual case when nothing else
 * denies the addressed name.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Names that already exist under `shared/` (as repo-structural files or as
 * members of `SHARED_LINKS`) that a `sharedDirs` entry must not collide with.
 * Adding a `sharedDirs` entry matching one of these would either shadow a
 * structural file or create a duplicate symlink pointing at the same target.
 */
const RESERVED_SHARED = new Set([
  'settings.base.json',
  'CLAUDE.md',
  'agents',
  'skills',
  'commands',
  'rules',
  'my-statusline.cjs',
  'hooks',
  'hosts',
  'path-map.json',
  'extras',
  'projects',
]);

/**
 * `RESERVED_SHARED` folded to lowercase, for the case-insensitive probe in
 * {@link validateSharedDirEntry}. Two of the reserved names are not lowercase
 * (`CLAUDE.md`, `my-statusline.cjs`), so the probe cannot simply lowercase the
 * candidate and test it against the original set.
 */
const RESERVED_SHARED_FOLDED = new Set([...RESERVED_SHARED].map((name) => name.toLowerCase()));

/**
 * Win32 device names, which are reserved at every path level and with any
 * extension: `NUL`, `nul.json` and `CON.md` all address the device, not a file.
 * A `sharedDirs` entry naming one cannot be created or copied on native
 * Windows, where shared names are materialized as real files rather than
 * symlinks, so accepting it hands that host an unfixable per-name failure on
 * every pull. Rejected on all platforms: `path-map.json` syncs, so a name
 * accepted on Linux lands on the Windows host that cannot use it.
 */
const WIN32_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_unused, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_unused, i) => `lpt${i + 1}`),
]);

/**
 * Machine-comparable cause for a rejected `sharedDirs` entry. The declaration
 * order below is NOT the evaluation order: `win32-alias` is tested LAST, as
 * the residual cause when nothing else denies the name the entry addresses.
 * A string-literal union, not a TS `enum`, because `erasableSyntaxOnly`
 * forbids enums.
 */
export type SharedDirRejectionReason =
  'not-a-string' | 'not-a-segment' | 'win32-alias' | 'never-sync' | 'reserved' | 'secret-shaped';

/**
 * Result of a failed `validateSharedDirEntry` check: a machine-comparable
 * `reason` identifier plus a human-readable `message` fragment. Callers that
 * only need pass/fail use `isValidSharedDir` instead.
 */
export type SharedDirRejection = {
  reason: SharedDirRejectionReason;
  message: string;
};

/**
 * Validate a `sharedDirs` entry from `path-map.json` and name the specific
 * reason a rejected entry was refused. Returns `null` when `entry` is safe to
 * use as a symlink target under `~/.claude/`; otherwise returns the first
 * matching {@link SharedDirRejection}.
 *
 * The real evaluation order: not a string, not a single path segment, then
 * the cause of the name this host actually ADDRESSES, via
 * `classifyDeniedName(stripTrailingDots(entry))`, and finally the trailing
 * dot itself as the residual cause when nothing else denies the addressed
 * name.
 *
 * The invariant is NOT that a rejection keeps its reported cause. It does
 * not: classifying by the addressed name deliberately moved every
 * trailing-dot spelling out of `win32-alias` and into the cause of the file
 * it reaches. What holds is that the accept/reject partition never changes,
 * only the reported cause, and the cause always describes the path the host
 * resolves. A name that was refused stays refused, and no name that was
 * accepted becomes refused, for any suffix of dots.
 *
 * Within `classifyDeniedName` the credential-shape check still runs last, so
 * a `NEVER_SYNC` member that also looks credential-shaped (e.g.
 * `.credentials.json`) keeps reporting `never-sync`.
 *
 * The name and reserved probes are case-insensitive, matching `isDeniedName`
 * and for the same reason: on a case-insensitive filesystem (macOS default,
 * NTFS) a mixed-case `Settings.local.json` resolves to the same inode as the
 * denied `settings.local.json`, so an exact-case `Set.has` would accept a
 * `sharedDirs` entry that then gets symlinked over this host's per-host
 * settings file. `isSecretFileName` already folds case in its own patterns.
 *
 * Accepts `unknown` because `path-map.json` is runtime input: a malformed
 * `sharedDirs` array can hold non-string values (numbers, objects, null) that
 * `SAFE_SEGMENT.test` would otherwise string-coerce (e.g. `42` -> `"42"`).
 * Rejecting non-strings first drops those shapes deterministically.
 *
 * @param entry - Candidate `sharedDirs` value from `path-map.json`.
 * @returns `null` if safe; otherwise the rejection reason and message.
 */
export function validateSharedDirEntry(entry: unknown): SharedDirRejection | null {
  if (typeof entry !== 'string') {
    return { reason: 'not-a-string', message: 'not a string' };
  }
  if (!SAFE_SEGMENT.test(entry) || entry === '.' || entry === '..') {
    return {
      reason: 'not-a-segment',
      message:
        'not a single path segment (contains a path separator, an unsupported character, "." or "..")',
    };
  }
  // Classify the name win32 would ACTUALLY address, not the one written. The
  // trailing dots are decoration there, so `.env.` is the credential file and
  // `commands.` is the managed directory, and each must report the cause that
  // describes what it reaches. Testing the written form first labelled every
  // one of them `win32-alias`, which shadowed those causes and left `.env.`
  // with no other surface naming it: it is absent from NEVER_SYNC and
  // `isSecretFileName` does not match it either.
  const addressed = stripTrailingDots(entry);
  const named = classifyDeniedName(addressed);
  if (named !== null) {
    // Say which name the cause is about. `commands.` is not itself in the
    // reserved set and `.env.` matches none of the credential patterns, so
    // reporting the bare cause tells the user something checkably false about
    // the string they typed.
    return addressed === entry
      ? named
      : {
          reason: named.reason,
          message: `a trailing-dot name addressing ${named.message} (win32 strips the dot)`,
        };
  }
  // Reached only when the addressed name is denied by nothing, so the trailing
  // dot is the whole objection. Its OWN cause rather than `not-a-segment`,
  // because such a name is a single safe segment that every released nomad
  // accepted and symlinked: folding it into the traversal cause would strand a
  // link this host has and then say the repo is safe to delete.
  if (entry.endsWith('.')) {
    return {
      reason: 'win32-alias',
      message:
        'a trailing-dot name (win32 strips the dot, so it addresses a different path than it names)',
    };
  }
  return null;
}

/**
 * Drop every trailing `.` from `name`, giving the path win32 resolves it to.
 *
 * A loop rather than a `/\.+$/` replace: an anchored quantifier over a
 * repeated character is the shape `sonarjs/super-linear-regex` rejects, and
 * this runs on unvalidated `path-map.json` input.
 *
 * @param name - A single path segment.
 * @returns The segment without trailing dots, possibly empty.
 */
function stripTrailingDots(name: string): string {
  let end = name.length;
  while (end > 0 && name[end - 1] === '.') end -= 1;
  return name.slice(0, end);
}

/**
 * Report whether `name` is denied on its own terms: a `NEVER_SYNC` member, a
 * reserved `shared/` name, a reserved Windows device name, or a
 * credential-shaped filename.
 *
 * Split from {@link validateSharedDirEntry} so the same four checks can be
 * tested against the name a host actually resolves rather than the one the user
 * typed. Case-insensitive throughout, matching `isDeniedName`: on macOS and NTFS
 * a mixed-case `Settings.local.json` is the same inode as the denied lowercase
 * spelling, so an exact-case `Set.has` would accept an entry that then gets
 * symlinked over this host's per-host settings.
 *
 * @param name - A single path segment, already normalized for trailing dots.
 * @returns The matching rejection, or `null` when nothing denies the name.
 */
function classifyDeniedName(name: string): SharedDirRejection | null {
  const folded = name.toLowerCase();
  if (NEVER_SYNC.has(name) || NEVER_SYNC.has(folded)) {
    return { reason: 'never-sync', message: 'a never-sync name' };
  }
  if (RESERVED_SHARED.has(name) || RESERVED_SHARED_FOLDED.has(folded)) {
    return { reason: 'reserved', message: 'a reserved shared/ name' };
  }
  // Device names are reserved with any extension, so test the stem. `indexOf`
  // rather than a regex (a `.*$` form backtracks super-linearly) or
  // `split(...)[0]` (types as possibly-undefined, adding an unreachable branch
  // to a file the patch gate holds at 100%).
  const dot = folded.indexOf('.');
  const stem = dot === -1 ? folded : folded.slice(0, dot);
  if (WIN32_DEVICE_NAMES.has(stem)) {
    return { reason: 'reserved', message: 'a reserved Windows device name' };
  }
  if (isSecretFileName(name)) {
    return {
      reason: 'secret-shaped',
      message: 'a credential-shaped filename (.env, id_rsa, credentials, *.pem, *.key and similar)',
    };
  }
  return null;
}

/**
 * Causes whose entries can never be joined into a filesystem path, on any host.
 * `not-a-string` is a coercion shape and `not-a-segment` is the traversal one
 * (`../escape`, `foo/bar`), which `join` would normalize straight out of the
 * directory the caller meant.
 */
const UNJOINABLE_REASONS: ReadonlySet<SharedDirRejectionReason> = new Set([
  'not-a-string',
  'not-a-segment',
]);

/**
 * Whether a REFUSED `sharedDirs` entry may still be joined into a filesystem
 * path on this host, for a consumer that acts on names the guard rejected.
 *
 * Two such consumers exist and they disagree, legitimately, about WHICH
 * causes are worth acting on for a NON-DOTTED name: `nomad doctor` offers
 * remediation for a name it no longer manages but excludes `reserved`, since
 * those are managed right now and the advice would target live content;
 * `nomad eject` must materialize anything this host already has, `reserved`
 * included. That difference is the `remediable` parameter, and it is
 * consulted only when the entry is not a trailing-dot spelling; see the
 * alias rule below for that case. Everything before `remediable` is the part
 * neither consumer may decide for itself, because getting it wrong joins an
 * attacker-influenced string into a path.
 *
 * Ordering is load-bearing and is the whole reason this lives in one place.
 * The unjoinable causes are tested FIRST: `../escape.` ends with a dot AND is a
 * traversal, so an alias test placed ahead of the safety test answers `true`
 * for it on posix.
 *
 * The alias rule is keyed on the entry's SPELLING, never on its cause. Win32
 * strips a trailing dot, so such a name addresses a different path than it
 * spells: `commands.` reaches the live `shared/commands` and `...` the config
 * root itself, so no consumer may join one there. On posix it is an ordinary
 * distinct directory that aliases nothing, so it stands on its own regardless
 * of the cause it inherited from the name win32 WOULD have resolved it to.
 *
 * @param entry - The refused entry, as written in `path-map.json`.
 * @param reason - The cause {@link validateSharedDirEntry} reported for it.
 * @param remediable - Causes this particular consumer acts on.
 * @returns `true` when the entry is safe to join and in scope for the caller.
 */
export function mayJoinRefusedEntry(
  entry: string,
  reason: SharedDirRejectionReason,
  remediable: ReadonlySet<SharedDirRejectionReason>,
): boolean {
  if (UNJOINABLE_REASONS.has(reason)) return false;
  if (entry.endsWith('.')) return process.platform !== 'win32';
  return remediable.has(reason);
}

/**
 * Boolean wrapper over {@link validateSharedDirEntry}: `true` when `entry` is
 * a valid `sharedDirs` path segment (a single path segment not present in
 * `NEVER_SYNC`, not a reserved `shared/` name, and not a credential-shaped
 * filename). Invalid entries are dropped with a WARN by the caller
 * (`allSharedLinks` in `config.ts`) rather than throwing a fatal error,
 * mirroring the resilience of the existing extras path.
 *
 * Kept as a thin same-signature wrapper so its three consumers (`config.ts`,
 * `commands.adopt.ts`, `commands.push.allowlist.ts`) inherit the
 * credential-shape rejection with no edit to any call site.
 *
 * @param entry - Candidate `sharedDirs` value from `path-map.json`.
 * @returns `true` if the entry is safe to use as a symlink target under `~/.claude/`.
 */
export function isValidSharedDir(entry: unknown): entry is string {
  return validateSharedDirEntry(entry) === null;
}
