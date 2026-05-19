// Stub for RED phase. Real implementation lands in GREEN.

/** Scaffold an empty REPO_HOME. Implemented in GREEN. */
export function cmdInit(): void {
  throw new Error('cmdInit not implemented');
}

/** Classify a repo by three signals; implemented in GREEN. */
export function classifyRepoState(
  _repoHome: string,
  _host: string,
): 'empty' | 'partial' | 'populated' {
  throw new Error('classifyRepoState not implemented');
}
