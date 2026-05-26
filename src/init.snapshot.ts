import { copyFileSync, cpSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_HOME, HOST, REPO_HOME, SHARED_LINKS } from './config.ts';
import { die, log } from './utils.ts';
import { writeJsonAtomic } from './utils.fs.ts';
import { readJson } from './utils.json.ts';

/**
 * Overlay `~/.claude/` SHARED_LINKS onto the freshly-written scaffold under
 * `REPO_HOME/shared/`. Regular files (`CLAUDE.md`, `my-statusline.cjs`) go
 * through `copyFileSync` so the placeholder is overwritten; directories
 * (`agents`, `skills`, `commands`, `rules`) drop their just-written
 * `.gitkeep` marker first and then go through `cpSync` with `force: false`,
 * so any unexpected pre-existing destination content (an out-of-band write
 * between the preflight check and this step) surfaces as an error. Also
 * translates `~/.claude/settings.json` (when present) into `hosts/<HOST>.json`
 * via `writeJsonAtomic`. Does NOT modify `~/.claude/`; the caller emits the
 * user-visible next-step + originals-not-removed log lines so the canonical
 * phrasing stays co-located with `cmdInit` itself.
 */
export function snapshotIntoShared(): void {
  for (const name of SHARED_LINKS) {
    const src = join(CLAUDE_HOME, name);
    if (!existsSync(src)) continue;
    const dst = join(REPO_HOME, 'shared', name);
    if (statSync(src).isDirectory()) {
      // Remove the .gitkeep first so cpSync starts against an empty dst.
      // Force is false so existing files are not overwritten; errorOnExist
      // is true because cpSync silently ignores destination collisions when
      // it is omitted, defeating the intent of surfacing unexpected content
      // (e.g. an out-of-band write between the preflight check and here).
      const gk = join(dst, '.gitkeep');
      if (existsSync(gk)) rmSync(gk);
      cpSync(src, dst, { recursive: true, force: false, errorOnExist: true });
    } else {
      copyFileSync(src, dst);
    }
    log(`snapshotted shared/${name} from ${src}`);
  }

  const userSettings = join(CLAUDE_HOME, 'settings.json');
  if (existsSync(userSettings)) {
    // `return die(...)` keeps `parsed` definitely-assigned for the writeJsonAtomic call.
    let parsed: Record<string, unknown>;
    try {
      parsed = readJson<Record<string, unknown>>(userSettings);
    } catch (err) {
      return die(`malformed ${userSettings}: ${(err as Error).message}`);
    }
    const hostFile = join(REPO_HOME, 'hosts', `${HOST}.json`);
    writeJsonAtomic(hostFile, parsed);
    log(`snapshotted hosts/${HOST}.json from ${userSettings}`);
  }
}
