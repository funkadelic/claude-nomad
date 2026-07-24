/**
 * The nomad process exit-code contract: a small, named set of integers a
 * scripted caller can branch on via `$?` without parsing stderr text. Every
 * code, once shipped, is a permanent compatibility promise: values may be
 * added in a future release but an existing value is never repurposed or
 * removed.
 *
 * Value `3` is intentionally RESERVED and unassigned. Lock contention
 * (another nomad process already holds the lock) is an intentional
 * "skip, do not fail" outcome and keeps returning `EXIT.SUCCESS` (0); it does
 * not get a dedicated code.
 *
 * Dependency-free leaf module, mirroring `config.never-sync.ts`: zero
 * imports, safe for any other module to import without creating a cycle.
 */
export const EXIT = {
  /** Completed successfully. Also returned when a held lock causes a no-op skip. */
  SUCCESS: 0,
  /** Unclassified failure; the default for any error not mapped to a more specific code. */
  GENERIC_FAILURE: 1,
  /** Bad argv: unknown subcommand, unknown flag, or malformed flag value. */
  USAGE: 2,
  /** A wedged repo state (e.g. an unresolved rebase) needing manual git resolution. */
  CONFLICT: 4,
  /** gitleaks confirmed a secret in the staged tree and the push was aborted. */
  LEAK_BLOCKED: 5,
  /**
   * The user interrupted an interactive prompt with Ctrl+C and nothing was
   * left half-written. The conventional 128 + SIGINT(2) value.
   */
  INTERRUPTED: 130,
} as const;

/** Union of every value in {@link EXIT}. */
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
