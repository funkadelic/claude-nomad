/**
 * Produce git `remote -v` formatted output from a map of remote names to URLs.
 *
 * Each entry produces two lines: one with `(fetch)` and one with `(push)`.
 * `parseRemotes` only consumes `(fetch)`, but emitting production-shaped
 * output keeps the test honest against the real git CLI format.
 *
 * @param remotes - Mapping of remote name to its URL
 * @returns A `git remote -v`-style string where each remote has `(fetch)` and `(push)` lines; includes a trailing newline when there is at least one line
 */
export function formatRemoteV(remotes: Record<string, string>): string {
  const lines: string[] = [];
  for (const [name, url] of Object.entries(remotes)) {
    lines.push(`${name}\t${url} (fetch)`, `${name}\t${url} (push)`);
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

/** Shape passed to `mockGit` so each test declares only the bits it cares
 * about; defaults cover the "vanilla healthy" path. */
export type GitBehavior = {
  remotes?: Record<string, string>;
  branch?: string;
  status?: string;
  diffNames?: string;
  pullThrows?: Error;
  fetchThrows?: Error;
  mergeThrows?: Error;
  /** When set, `git rev-parse --abbrev-ref HEAD` throws this error. Used to
   * exercise `currentBranch`'s NomadFatal-wrapping catch arm. */
  branchThrows?: Error;
  /** When set, `git rev-parse HEAD` throws this error. Used to exercise
   * `headSha`'s NomadFatal-wrapping catch arm. */
  headShaThrows?: Error;
  /** Successive `git rev-parse HEAD` return values, consumed in order (one
   * per call) and sticky on the last entry once exhausted. Lets a test model
   * HEAD advancing across a merge (distinct pre/post SHAs) or staying put (a
   * single entry, or unset for the constant default). Mutated in place. */
  headShas?: string[];
  /** When set, `git remote -v` throws this error. Used to exercise
   * `loadTopology`'s NomadFatal-wrapping catch arm. */
  remoteThrows?: Error;
  /** Output for `git diff --name-only --diff-filter=U`: newline-separated
   * unmerged paths after a failed merge. Empty/unset = no unmerged paths. */
  unmergedPaths?: string;
  /** When set, `git diff --name-only --diff-filter=U` throws this error.
   * Used to verify the auto-resolve probe degrades gracefully and the
   * original merge failure surfaces instead of a probe exception. */
  diffThrows?: Error;
};

/** Per-command handler: returns the canned output (or throws the configured
 * error). Each handler is keyed by `git ${args[0]}` or `npm ${args[0]}` for
 * dispatch via a table, which keeps `mockGit`'s `execFileSync` body flat. */
type Handler = (behavior: GitBehavior, args: readonly string[]) => Buffer;

/** Dispatch table consumed by `mockGit`: maps `${bin} ${args[0]}` to the
 * handler that returns the canned git/npm output (or throws). Extracted from
 * the helper module so `mockGit` stays under the line cap. */
export const HANDLERS: Record<string, Handler> = {
  'git remote': (b, args) => {
    if (args[1] !== '-v') throw new Error(`unhandled: git remote ${args.join(' ')}`);
    if (b.remoteThrows !== undefined) throw b.remoteThrows;
    return Buffer.from(formatRemoteV(b.remotes ?? {}));
  },
  'git rev-parse': (b, args) => {
    if (args[1] === '--abbrev-ref') {
      if (b.branchThrows !== undefined) throw b.branchThrows;
      return Buffer.from((b.branch ?? 'main') + '\n');
    }
    if (args[1] === 'HEAD') {
      if (b.headShaThrows !== undefined) throw b.headShaThrows;
      const seq = b.headShas;
      if (seq !== undefined && seq.length > 0) {
        const next = seq.length > 1 ? seq.shift()! : seq[0];
        return Buffer.from(next + '\n');
      }
      return Buffer.from('0123456789abcdef0123456789abcdef01234567\n');
    }
    throw new Error(`unhandled: git rev-parse ${args.join(' ')}`);
  },
  'git status': (b) => Buffer.from(b.status ?? ''),
  'git pull': (b) => {
    if (b.pullThrows !== undefined) throw b.pullThrows;
    return Buffer.from('');
  },
  'git fetch': (b) => {
    if (b.fetchThrows !== undefined) throw b.fetchThrows;
    return Buffer.from('');
  },
  'git merge': (b) => {
    if (b.mergeThrows !== undefined) throw b.mergeThrows;
    return Buffer.from('');
  },
  'git push': () => Buffer.from(''),
  'git diff': (b, args) => {
    if (args.includes('--diff-filter=U')) {
      if (b.diffThrows !== undefined) throw b.diffThrows;
      return Buffer.from(b.unmergedPaths ?? '');
    }
    return Buffer.from(b.diffNames ?? '');
  },
  'git checkout': () => Buffer.from(''),
  'git add': () => Buffer.from(''),
  'git commit': () => Buffer.from(''),
  'npm install': () => Buffer.from(''),
};
