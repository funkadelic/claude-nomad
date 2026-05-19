import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type PathMap, REPO_HOME } from './config.ts';
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
 * Pre-flight refuse-to-clobber list (D-01). If ANY of these absolute paths
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
 * Scaffold an empty REPO_HOME with the minimal layout `cmdDoctor` expects:
 * `shared/CLAUDE.md` (HTML-comment placeholder), four `shared/<name>/.gitkeep`
 * markers, `shared/settings.base.json = {}`, `hosts/.gitkeep`, and a root
 * `path-map.json = {"projects":{}}`. Does NOT auto-commit (D-01: user reviews
 * and commits explicitly) and does NOT acquire the pull/push lock (D-08: init
 * is a one-shot against an empty target; no concurrent-mutator surface).
 *
 * Aborts with NomadFatal containing `already initialized` and the offending
 * path if the target is already populated; the refuse-to-clobber guard
 * intentionally fires on a bare `shared/` dir too, since partial state is
 * unsafe to merge with (D-01).
 */
export function cmdInit(): void {
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
  // structure being built. Atomic writes for the JSON files so a power loss
  // mid-init leaves either a clean fresh-clone state or the fully-written
  // scaffold, never a half-written JSON the next pull would die on.
  writeFileSync(join(REPO_HOME, 'shared', 'CLAUDE.md'), SHARED_CLAUDE_MD);
  log('created shared/CLAUDE.md');
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

  log('init complete');
}

/**
 * Read-only health classifier for `cmdDoctor`'s `repo state:` header (D-04).
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
