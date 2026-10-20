import { copyFileSync, cpSync, existsSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { allSharedLinks, claudeHome, HOST, repoHome, type PathMap } from '../../core/config.ts';
import { die, log } from '../../core/utils.ts';
import { writeJsonAtomic } from '../../core/utils.fs.ts';
import { readJson } from '../../core/utils.json.ts';

/**
 * Overlay `~/.claude/` entries for every name in `allSharedLinks(map)` (the
 * static shared-link set plus any validated `sharedDirs` entries) onto the
 * freshly-written scaffold under `REPO_HOME/shared/`. Regular files
 * (`CLAUDE.md`, `my-statusline.cjs`) go through `copyFileSync` so the
 * placeholder is overwritten; directories (`agents`, `skills`, `commands`,
 * `rules`) drop their just-written `.gitkeep` marker and the emptied directory, then go through
 * `cpSync` with `force: false`, so any unexpected pre-existing destination
 * content surfaces as an error. Also translates `~/.claude/settings.json`
 * (when present) into `hosts/<HOST>.json` via `writeJsonAtomic`. Does NOT
 * modify `~/.claude/`; the caller emits the user-visible next-step +
 * originals-not-removed log lines so the canonical phrasing stays co-located
 * with `cmdInit` itself.
 */
export function snapshotIntoShared(map: PathMap): void {
  const repo = repoHome();
  const claude = claudeHome();
  for (const name of allSharedLinks(map)) {
    const src = join(claude, name);
    if (!existsSync(src)) continue;
    const dst = join(repo, 'shared', name);
    if (statSync(src).isDirectory()) {
      // Drop the .gitkeep, then the emptied dst itself: Node 24.22+ makes
      // errorOnExist reject an existing destination dir even when empty.
      // rmdirSync throws ENOTEMPTY on unexpected content (e.g. an out-of-band
      // write since the preflight), and errorOnExist still guards the copy.
      const gk = join(dst, '.gitkeep');
      if (existsSync(gk)) rmSync(gk);
      if (existsSync(dst)) rmdirSync(dst);
      cpSync(src, dst, { recursive: true, force: false, errorOnExist: true });
    } else {
      copyFileSync(src, dst);
    }
    log(`snapshotted shared/${name} from ${src}`);
  }

  const userSettings = join(claude, 'settings.json');
  if (existsSync(userSettings)) {
    // `return die(...)` keeps `parsed` definitely-assigned for the writeJsonAtomic call.
    let parsed: Record<string, unknown>;
    try {
      parsed = readJson<Record<string, unknown>>(userSettings);
    } catch (err) {
      return die(`malformed ${userSettings}: ${(err as Error).message}`);
    }
    const hostFile = join(repo, 'hosts', `${HOST}.json`);
    writeJsonAtomic(hostFile, parsed);
    log(`snapshotted hosts/${HOST}.json from ${userSettings}`);
  }
}
