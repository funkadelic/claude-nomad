/** Dependency-free TTY predicate shared by the spinner and push recovery. */

/**
 * True when both stdin and stdout are interactive TTYs. Accepts injectable
 * stream objects so tests can drive the branch without a real TTY.
 *
 * @param stdin Readable with optional `isTTY` flag (default: `process.stdin`).
 * @param stdout Writable with optional `isTTY` flag (default: `process.stdout`).
 * @returns True iff both streams report `isTTY === true`.
 */
export function isTTY(
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}
