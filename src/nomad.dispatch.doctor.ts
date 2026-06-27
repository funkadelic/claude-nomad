/**
 * Parsed result of the `doctor` argv tail (everything after `nomad doctor`).
 * - `run`: execute the health check with the resolved sub-flags.
 * - `resume`: print the resume command for `id` (the `--resume-cmd` path).
 * - `error`: malformed argv; the caller prints usage and exits non-zero.
 */
export type DoctorArgs =
  | {
      kind: 'run';
      checkShared: boolean;
      checkSchema: boolean;
      checkRemote: boolean;
      verbose: boolean;
    }
  | { kind: 'resume'; id: string }
  | { kind: 'error' };

/**
 * Parse the `doctor` argv tail into a {@link DoctorArgs}. `--resume-cmd <id>` is
 * exclusive (it takes exactly one non-empty id and combines with nothing else);
 * the scan flags `--check-shared` / `--check-schema` / `--check-remote` and the
 * verbosity flags `--verbose` / `--all` / `-v` compose freely. Any unrecognized
 * token makes the whole invocation an error rather than being silently ignored.
 *
 * @param args - argv after the `doctor` subcommand (e.g. `process.argv.slice(3)`).
 * @returns the parsed shape; never throws.
 */
export function parseDoctorArgs(args: string[]): DoctorArgs {
  if (args[0] === '--resume-cmd') {
    // `--resume-cmd` is exclusive: exactly one trailing non-empty id, nothing
    // else. When length is 2, args[1] is always a string (the input is a clean
    // string[]), so a length check plus an emptiness check fully validate it.
    const id = args[1];
    if (args.length !== 2 || id.length === 0) return { kind: 'error' };
    return { kind: 'resume', id };
  }
  let checkShared = false;
  let checkSchema = false;
  let checkRemote = false;
  let verbose = false;
  for (const arg of args) {
    if (arg === '--check-shared') checkShared = true;
    else if (arg === '--check-schema') checkSchema = true;
    else if (arg === '--check-remote') checkRemote = true;
    else if (arg === '--verbose' || arg === '--all' || arg === '-v') verbose = true;
    else return { kind: 'error' };
  }
  return { kind: 'run', checkShared, checkSchema, checkRemote, verbose };
}
