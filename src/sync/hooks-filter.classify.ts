/**
 * Classifies a hook entry's `command` string as gsd-owned or user-authored,
 * split out of `hooks-filter.ts` so shell-command parsing lives apart from the
 * settings-block filtering that consumes it. Sibling of
 * `hooks-filter.command-sub.ts`, which handles command substitutions.
 */

import { GSD_PREFIX } from '../core/config.ts';
import { opensSubstitution, skipSubstitution } from './hooks-filter.command-sub.ts';

/**
 * Launcher binaries that may precede a script token, telling `/usr/bin/node
 * script.js` apart from a launcher-less `/a/hooks/gsd-x.js --flag`. `env` is
 * here so `/usr/bin/env node script.js` is not read as a script named `env`;
 * it only works alongside the chain walk in `resolveScriptWord`.
 */
const KNOWN_LAUNCHER_BASENAMES = new Set(['env', 'node', 'bash', 'sh']);

/**
 * A BARE candidate word carrying a backtick, paren, or quote is a leftover
 * fragment from an unresolved command substitution, not a script name. A lone
 * `$` is deliberately absent: `$HOOK` is an ordinary expansion, and treating it
 * as an artifact would read the NEXT token as the script and drop a user hook.
 */
const SUBSTITUTION_ARTIFACT = /[`()'"]/;

/**
 * Matches a leading `KEY=value` environment-assignment token. Such a token is
 * never a script path, in launcher position or after an `env`.
 */
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;

/**
 * Shell control operators that separate commands. Never a script path, so the
 * walk steps over them rather than reading one as the script (which would
 * classify the entry as user-authored and lose a real gsd hook on pull).
 */
const SHELL_OPERATORS = new Set(['&&', '||', ';', '|', '&']);

/**
 * Basename of a path token (handles both `/` and `\` separators).
 *
 * @param token - A command token that may be a path.
 * @returns The last path segment, or the token unchanged when it has no separator.
 */
function scriptBasename(token: string): string {
  const lastSlash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return lastSlash >= 0 ? token.slice(lastSlash + 1) : token;
}

/**
 * Strip one balanced pair of surrounding ASCII quotes from a command token.
 * The tokenizer keeps quotes attached, so `"node" "gsd-x.js"` would otherwise
 * read as `node"` / `gsd-x.js"` and evade both launcher detection and the
 * `gsd-` prefix check. No-op for an unquoted token.
 */
function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const head = token.at(0);
    const tail = token.at(-1);
    if ((head === '"' && tail === '"') || (head === "'" && tail === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/** A word from the command that could be the script path. */
interface Candidate {
  /** Index of the token it came from, or `-1` when no candidate remains. */
  index: number;
  /** The word itself, which may be a suffix of that token. */
  word: string;
}

/** No script word remains in the command. */
const NO_CANDIDATE: Candidate = { index: -1, word: '' };

/**
 * Walk forward to the next word that could be a script path, stepping over
 * flags, shell operators, and whole command substitutions. A substitution that
 * closes part-way through its last token yields the remainder, which is the
 * `$(dirname "$0")/hook.js` idiom for naming a file beside the script.
 */
function nextScriptWord(tokens: string[], from: number, inScriptSlot: boolean): Candidate {
  let slot = inScriptSlot;
  let i = from;
  while (i < tokens.length) {
    const token = tokens[i];
    if (SHELL_OPERATORS.has(token)) {
      slot = false;
      i++;
    } else if (token.startsWith('-')) {
      i++;
    } else if (!opensSubstitution(token)) {
      return { index: i, word: token };
    } else {
      // In launcher position a wholly-consumed substitution IS the launcher, so
      // the walk continues past it. In the script slot it is the script and
      // what it expands to is unknowable, so the walk gives up rather than
      // reading the next argument as the script. A shell operator right after
      // it ends the command, which puts the walk back in launcher position.
      const end = skipSubstitution(tokens, i);
      if (end.rest !== '') return { index: end.next - 1, word: end.rest };
      if (slot && !SHELL_OPERATORS.has(tokens[end.next] ?? '')) return NO_CANDIDATE;
      i = end.next;
    }
  }
  return NO_CANDIDATE;
}

/**
 * Walk from the script slot to the real script, stepping over a chained bare
 * interpreter or `KEY=value` only under `env`, the one launcher that
 * guarantees the next bare word is an interpreter. Elsewhere `bash node x.md`
 * would chain past a real script and drop a user hook.
 */
function resolveScriptWord(tokens: string[], from: number, underEnv: boolean): Candidate {
  let candidate = nextScriptWord(tokens, from, true);
  while (underEnv && candidate.index >= 0) {
    const word = stripQuotes(candidate.word);
    const isBareInterpreter =
      !word.includes('/') && !word.includes('\\') && KNOWN_LAUNCHER_BASENAMES.has(word);
    if (!isBareInterpreter && !ENV_ASSIGNMENT.test(word)) return candidate;
    candidate = nextScriptWord(tokens, candidate.index + 1, true);
  }
  return candidate;
}

// Observed gsd launcher forms, node variants. This inventory is the checklist to
// re-verify against a live gsd-core install when touching this classifier:
//   node /a/b/.claude/hooks/gsd-context-monitor.js
//   node --preserve-symlinks-main /a/hooks/gsd-workflow-guard.js
//   /home/u/.nvm/versions/node/v24/bin/node /a/hooks/gsd-config-reload.js

// Observed gsd launcher forms, shells and env prefixes:
//   bash /a/hooks/gsd-graphify-update.sh
//   CLAUDE_PROJECT_DIR=/x node /a/hooks/gsd-x.js
//   /usr/bin/env node /a/hooks/gsd-x.js

// Observed gsd launcher forms, launcher-less and quoted:
//   /a/hooks/gsd-x.js (launcher-less, shebang executable)
//   "/abs/path/node" "/abs/path/gsd-x.js"
//   "$(for n in ... done)" "/a/hooks/gsd-x.js" (gsd's inline node-resolver)

// Handled defensively, NOT observed from gsd. A launcher-template change is what
// caused the incident this module exists for, so these fail toward keeping the
// entry rather than dropping it:
//   `command -v node` /a/hooks/gsd-x.js
//   sh -c "$(cat /a/x) && /a/hooks/gsd-x.js"
//   node $(pwd)/gsd-x.js

// Fail-safe direction: an unparseable command returns `false` so a user entry is
// never dropped. `false` is NOT unconditionally safe: for an entry gsd really did
// install it means the entry is treated as user state. That is why every
// unresolved shape above falls back to reading a literal token rather than
// giving up outright.

/**
 * Returns `true` when a hook entry's `command` names a script whose basename
 * starts with `gsd-`, so gsd installed it rather than the user. Keys off the
 * SCRIPT word, never a later one, so a trailing `gsd-` ARGUMENT cannot mark a
 * user script gsd-owned. Unparseable returns `false`: never drop a user entry.
 */
export function isGsdHookEntry(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] === '') return false;

  // Skip leading KEY=value env-assignment tokens.
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i])) {
    i++;
  }

  const launcher = nextScriptWord(tokens, i, false);
  if (launcher.index < 0) return false;
  const first = stripQuotes(launcher.word);
  const firstBase = scriptBasename(first);
  const firstHasPath = first.includes('/') || first.includes('\\');

  // Launcher-less form: the first candidate word is itself the script whenever
  // its basename is not a known launcher binary and the word either carries a
  // path or is a bare name that is not a substitution-parsing artifact. Covers
  // `/a/hooks/gsd-x.js` with or without trailing args, and a bare `gsd-x.js`.
  if (
    !KNOWN_LAUNCHER_BASENAMES.has(firstBase) &&
    (firstHasPath || !SUBSTITUTION_ARTIFACT.test(first))
  ) {
    return firstBase.startsWith(GSD_PREFIX);
  }

  // Otherwise that word is the launcher and the script is the next candidate.
  // Only under `env` does the walk step over a chained interpreter
  // (`env node x.js`). A launcher with no script -> false.
  const script = resolveScriptWord(tokens, launcher.index + 1, firstBase === 'env');
  if (script.index < 0) return false;
  return scriptBasename(stripQuotes(script.word)).startsWith(GSD_PREFIX);
}
