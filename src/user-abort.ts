/**
 * Structural detector for a deliberate user cancel of an interactive prompt,
 * as opposed to a genuine unexpected error. The error shapes this matches
 * originate inside Node internals (readline) and third-party prompt
 * libraries (the inquirer family), so no constructor is importable and
 * `instanceof` cannot be used; detection is by `name`/`code` shape only.
 *
 * Dependency-free leaf module, mirroring `config.never-sync.ts` and
 * `exit-codes.ts`: zero imports, safe for any other module to import
 * without creating a cycle.
 */

/** Error `name` values that identify a deliberate prompt cancel. */
const ABORT_NAMES = new Set(['AbortError', 'ExitPromptError']);

/** Error `code` value Node's readline interface sets on a Ctrl+C abort. */
const ABORT_CODE = 'ABORT_ERR';

/**
 * True when `err` is a Node readline abort (`name: 'AbortError'` or
 * `code: 'ABORT_ERR'`) or an inquirer-family prompt exit
 * (`name: 'ExitPromptError'`). Matches structurally on `name`/`code`, never
 * on message text (locale and version fragile) and never via `instanceof`
 * (the error is constructed inside code this module cannot import).
 *
 * @param err The unknown thrown value to classify.
 */
export function isUserAbort(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { name, code } = err as { name?: unknown; code?: unknown };
  return (typeof name === 'string' && ABORT_NAMES.has(name)) || code === ABORT_CODE;
}
