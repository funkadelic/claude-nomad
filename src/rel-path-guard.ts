/**
 * Shared per-segment traversal guard for a repo-relative finding path, used by
 * both the skill resolver (`commands/push/recovery/skills.ts`) and the memory
 * resolver (`commands/push/recovery/memory.ts`) so the multi-segment safety
 * check has a single source of truth. Pure and dependency-free (a bottom leaf
 * with no imports), it validates only the LEXICAL shape of a relative path; the
 * physical (symlink/realpath) containment guard stays with each resolver, which
 * knows its own on-disk root.
 */

/**
 * Per-segment traversal guard for a relative path extracted from a finding.
 * Rejects an empty path, a leading `/`, any backslash, then splits on `/` and
 * requires every segment be non-empty and not `.` or `..`. A flat
 * single-filename pattern would incorrectly reject legitimately nested files
 * (a skill's `references/notes.md`, a memory subtree's `<subdir>/x.md`), so
 * every segment is validated independently.
 *
 * @param relPath Candidate relative path extracted from a finding.
 * @returns true when every segment of `relPath` is safe.
 */
export function isSafeRelPath(relPath: string): boolean {
  if (relPath.length === 0 || relPath.startsWith('/') || relPath.includes('\\')) return false;
  const segments = relPath.split('/');
  return segments.every((s) => s.length > 0 && s !== '.' && s !== '..');
}
