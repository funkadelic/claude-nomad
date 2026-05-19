import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_HOME, type PathMap, REPO_HOME } from './config.ts';
import { snapshotIntoShared } from './init.snapshot.ts';
import { die, log, readJson, writeJsonAtomic } from './utils.ts';

/**
 * The HTML comment line that anchors `shared/CLAUDE.md` on a fresh scaffold.
 * Empty file would be silently misleading after symlinking into `~/.claude/`;
 * the comment makes the file self-describing when grep'd or `cat`-ed later.
 */
const SHARED_CLAUDE_MD =
  '<!-- claude-nomad shared CLAUDE.md; symlinked into ~/.claude/CLAUDE.md by nomad pull -->\n';

/**
 * Subdirectories under `shared/` that get a `.gitkeep` placeholder on a fresh
 * scaffold so the empty dirs survive git and materialize on every host. Pairs
 * with the SHARED_LINKS contract in `src/config.ts` (those same names are
 * symlinked into `~/.claude/` on every pull).
 */
const SHARED_KEEP_DIRS = ['agents', 'skills', 'commands', 'rules'] as const;

/**
 * Pre-flight refuse-to-clobber list. If ANY of these absolute paths
 * already exists at the target REPO_HOME, `cmdInit` aborts with a NomadFatal
 * naming the offender. Partial state is unsafe to merge with; init writes
 * only into a clean target. Note that REPO_HOME itself is allowed to exist
 * (e.g. it might be an empty dir created by `git clone` of an empty repo);
 * the guard fires only on artifacts cmdInit is about to write.
 */
function preflightConflict(repoHome: string): string | null {
  const candidates = [
    join(repoHome, 'shared', 'settings.base.json'),
    join(repoHome, 'shared', 'CLAUDE.md'),
    join(repoHome, 'path-map.json'),
    join(repoHome, 'hosts'),
    join(repoHome, 'shared'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Scaffold REPO_HOME with the minimal layout `cmdDoctor` expects: `shared/`
 * with `CLAUDE.md`, four `<name>/.gitkeep` markers, and an empty
 * `settings.base.json`; `hosts/.gitkeep`; root `path-map.json` =
 * `{"projects":{}}`. No auto-commit; no lock (no concurrent-mutator surface
 * on a fresh target).
 *
 * When `opts.snapshot` is true, the user's current `~/.claude/` SHARED_LINKS
 * are overlaid onto `shared/` and `~/.claude/settings.json` (if present) is
 * translated into `hosts/<HOST>.json`. The placeholder `shared/CLAUDE.md`
 * write is skipped when `~/.claude/CLAUDE.md` exists so the snapshot captures
 * verbatim content; originals are NOT removed. Aborts with NomadFatal
 * (containing `already initialized`) when any scaffold path already exists,
 * identical to plain init; a bare `shared/` dir is enough to refuse since
 * partial state is unsafe to merge with.
 */
export function cmdInit(opts: { snapshot?: boolean } = {}): void {
  const snapshot = opts.snapshot === true;

  const conflict = preflightConflict(REPO_HOME);
  if (conflict !== null) {
    die(`already initialized; refusing to clobber ${conflict}`);
  }

  // Create the directory structure first so the subsequent file writes have
  // a parent. `recursive: true` is a no-op when the dir already exists, but
  // the preflight guarantees it does not.
  mkdirSync(join(REPO_HOME, 'shared'), { recursive: true });
  mkdirSync(join(REPO_HOME, 'hosts'), { recursive: true });
  for (const name of SHARED_KEEP_DIRS) {
    mkdirSync(join(REPO_HOME, 'shared', name), { recursive: true });
  }

  // Per-artifact writes. Each emits a log line so the user sees the
  // structure being built. Atomic writes for JSON so a power loss mid-init
  // leaves either a clean fresh-clone state or the fully-written scaffold,
  // never a half-written JSON the next pull would die on. In snapshot mode,
  // skip the CLAUDE.md placeholder when a real source exists so the overlay
  // copies the user content verbatim instead of an overwrite-from-placeholder.
  const userClaudeMd = join(CLAUDE_HOME, 'CLAUDE.md');
  if (!snapshot || !existsSync(userClaudeMd)) {
    writeFileSync(join(REPO_HOME, 'shared', 'CLAUDE.md'), SHARED_CLAUDE_MD);
    log('created shared/CLAUDE.md');
  }
  for (const name of SHARED_KEEP_DIRS) {
    writeFileSync(join(REPO_HOME, 'shared', name, '.gitkeep'), '');
    log(`created shared/${name}/.gitkeep`);
  }
  writeFileSync(join(REPO_HOME, 'hosts', '.gitkeep'), '');
  log('created hosts/.gitkeep');
  writeJsonAtomic(join(REPO_HOME, 'shared', 'settings.base.json'), {});
  log('created shared/settings.base.json');
  writeJsonAtomic(join(REPO_HOME, 'path-map.json'), { projects: {} } satisfies PathMap);
  log('created path-map.json');

  if (snapshot) {
    snapshotIntoShared();
    log(`snapshot staged in shared/; review, then 'nomad push' to share with other hosts.`);
    log('~/.claude/ originals were NOT removed.');
  }

  log('init complete');
}

/**
 * Read-only health classifier for `cmdDoctor`'s `repo state:` header.
 * Inspects three signals at the given `repoHome`: `shared/settings.base.json`
 * presence, `path-map.json.projects` having at least one entry, and
 * `hosts/<host>.json` presence.
 *
 * Returns `'empty'` when the base is missing AND the path-map has no entries
 * (either missing or `projects` is empty); `'populated'` when all three
 * signals are positive; `'partial'` for anything in between. Malformed
 * `path-map.json` is treated as zero entries rather than thrown, so a doctor
 * run against a corrupted scaffold still produces a classification line.
 *
 * The `host` parameter is passed explicitly (rather than read from the
 * imported `HOST` constant) so the test fixture can drive multiple host
 * scenarios without mutating module-level state via `vi.resetModules()`.
 */
export function classifyRepoState(
  repoHome: string,
  host: string,
): 'empty' | 'partial' | 'populated' {
  const basePath = join(repoHome, 'shared', 'settings.base.json');
  const mapPath = join(repoHome, 'path-map.json');
  const hostPath = join(repoHome, 'hosts', `${host}.json`);

  const hasBase = existsSync(basePath);
  const hasMap = existsSync(mapPath);
  const hasHost = existsSync(hostPath);

  let mapEntryCount = 0;
  if (hasMap) {
    try {
      const map = readJson<PathMap>(mapPath);
      mapEntryCount = Object.keys(map.projects).length;
    } catch {
      // Malformed JSON: treat as zero entries, do NOT throw. The doctor's
      // own JSON-parse FAIL line will surface the malformed file separately.
      mapEntryCount = 0;
    }
  }

  if (!hasBase && mapEntryCount === 0) return 'empty';
  if (hasBase && mapEntryCount > 0 && hasHost) return 'populated';
  return 'partial';
}

/**
 * Suffix that follows `repo state: WARN partial` per the fixed priority
 * order. First matching condition wins, exactly one suffix per line.
 * Inspects the same on-disk signals `classifyRepoState` reads (base file,
 * `path-map.json` + its `.projects` entry count, `hosts/<host>.json`), but
 * explicitly distinguishes "path-map missing" from "path-map present but
 * empty" because users debug differently for each.
 *
 * Lives alongside `classifyRepoState` so the suffix rules and the classifier
 * stay co-located: changes to one almost always require updating the other.
 * Returns the string with a leading `- ` separator so the caller can
 * concatenate directly without re-deciding the separator.
 */
export function reasonForPartial(repoHome: string, host: string): string {
  const basePath = join(repoHome, 'shared', 'settings.base.json');
  const mapPath = join(repoHome, 'path-map.json');
  const hostPath = join(repoHome, 'hosts', `${host}.json`);
  if (!existsSync(basePath)) return '- shared/settings.base.json missing';
  if (!existsSync(mapPath)) return '- path-map.json missing';
  let mapEntryCount: number;
  try {
    const map = readJson<PathMap>(mapPath);
    mapEntryCount = Object.keys(map.projects).length;
  } catch {
    // Malformed JSON: treat as zero entries. Doctor's own JSON-parse FAIL
    // line surfaces the malformed file separately.
    mapEntryCount = 0;
  }
  if (mapEntryCount === 0) return '- path-map.json.projects has no entries';
  if (!existsSync(hostPath)) return `- hosts/${host}.json missing`;
  // Defensive fallback: classifyRepoState returned 'partial' for a reason
  // not captured by the four signals above. Should be unreachable in
  // practice because the priority order is exhaustive against the
  // classifier's definition of populated.
  return '- partial state (unknown gap)';
}
