/**
 * Shared `process.platform` stub for tests exercising platform-branching
 * code paths (win32 vs posix). Centralizes the `Object.defineProperty`
 * boilerplate that was previously hand-rolled in every consuming test file.
 */

/**
 * Overrides `process.platform` for the current test. Always defines the
 * property as `configurable: true` so a later call (e.g. an `afterEach`
 * restore back to the real platform) can redefine it again without
 * throwing.
 *
 * @param value - The platform value to stub (e.g. `'win32'`, `'darwin'`).
 */
export function stubPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}
