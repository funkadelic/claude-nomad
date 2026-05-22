import { cpSync, rmSync } from 'node:fs';

/**
 * Recursive mirror copy: removes `dst` first, then copies `src` into it.
 * `cpSync(force:true)` overwrites matching files but does not delete
 * dst-only entries; the upfront `rmSync` makes the operation a true mirror
 * so `dst` reflects `src` exactly rather than accumulating stale files.
 *
 * Differs from `copyDir` in `remap.ts` only by passing `verbatimSymlinks: true`
 * to `cpSync`. Without that flag, Node's default behavior rewrites relative
 * symlink targets inside the source tree to absolute paths into the source
 * host's filesystem (Pitfall 1; see nodejs/node issue 41693, fixed by the
 * flag introduced in Node 18). The repo would then carry dangling absolute
 * paths that break on every other host. The `.planning/` tree is the first
 * sync target that realistically contains symlinks, so the flag is required.
 *
 * Exported (not file-local) so the test file can call it directly; later
 * plans add the `remapExtrasPush` / `remapExtrasPull` wrappers that become
 * the primary public API.
 */
export function copyExtras(src: string, dst: string): void {
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true, force: true, verbatimSymlinks: true });
}
