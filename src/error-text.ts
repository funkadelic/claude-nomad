/**
 * The text to quote for a caught value, whatever was actually thrown.
 *
 * Every module that builds a failure message ending with the cause in
 * parentheses (`commands.adopt.recover.ts`, `commands.adopt.scan.ts`,
 * `links.mirror.ts`) calls this instead of reading `.message` directly.
 * Reading `.message` off an unknown value directly renders the literal
 * `undefined` for anything that is not an `Error`, which is the one place a
 * failure report cannot afford to go vague.
 *
 * Structural rather than `instanceof`, matching `isUserAbort` in
 * `user-abort.ts`: an `Error` crossing a realm boundary fails the prototype
 * check, and a thrown plain object carrying a `message` still says something
 * more useful than `[object Object]`.
 *
 * Dependency-free leaf module, mirroring `user-abort.ts`: zero imports, safe
 * for any other module to import without creating a cycle.
 */

/**
 * The text to quote for `err`, whatever was actually thrown.
 *
 * @param err - The caught value.
 * @returns Its `message` when it has a string one, otherwise its `String` form.
 */
export function errorText(err: unknown): string {
  const message = (err as Error | undefined)?.message;
  return typeof message === 'string' ? message : String(err);
}
