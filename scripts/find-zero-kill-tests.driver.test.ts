import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./find-zero-kill-tests.mjs', import.meta.url));

/**
 * Run the driver script as a subprocess via spawnSync, capturing exit status,
 * stdout, and stderr without throwing on a non-zero exit. Used to pin the
 * documented exit-code contract of the CLI entry point.
 *
 * @param args Arguments passed after the script path (typically a report path).
 * @returns The spawnSync result with decoded utf8 stdout/stderr.
 */
function runDriver(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('find-zero-kill-tests.mjs driver', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'zero-kill-driver-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits ZERO-KILL lines and exits 0 for a valid report', () => {
    const reportPath = join(dir, 'valid.json');
    writeFileSync(
      reportPath,
      JSON.stringify({
        files: { 'src/foo.ts': { mutants: { '0': { killedBy: ['test-A'] } } } },
        testFiles: {
          'src/foo.test.ts': {
            tests: [
              { id: 'test-A', name: 'foo kills' },
              { id: 'test-B', name: 'foo zero-kill' },
            ],
          },
        },
      }),
    );

    const { status, stdout } = runDriver([reportPath]);

    expect(status).toBe(0);
    expect(stdout).toContain('ZERO-KILL  src/foo.test.ts > foo zero-kill');
    expect(stdout).not.toContain('foo kills');
  });

  it('exits 1 with a stderr message when the report file is missing', () => {
    const { status, stderr } = runDriver([join(dir, 'does-not-exist.json')]);

    expect(status).toBe(1);
    expect(stderr).toContain('cannot read');
  });

  it('exits 1 with a stderr message on invalid JSON', () => {
    const reportPath = join(dir, 'invalid.json');
    writeFileSync(reportPath, 'not json {');

    const { status, stderr } = runDriver([reportPath]);

    expect(status).toBe(1);
    expect(stderr).toContain('JSON parse error');
  });

  it('exits 1 with a stderr message when the report is a scalar (IN-02)', () => {
    const reportPath = join(dir, 'scalar.json');
    writeFileSync(reportPath, '42');

    const { status, stderr } = runDriver([reportPath]);

    expect(status).toBe(1);
    expect(stderr).toContain('report is not an object');
  });

  it('exits 1 with a stderr message when the report is null (IN-02)', () => {
    const reportPath = join(dir, 'null.json');
    writeFileSync(reportPath, 'null');

    const { status, stderr } = runDriver([reportPath]);

    expect(status).toBe(1);
    expect(stderr).toContain('report is not an object');
  });

  it('runs the main block when invoked via a symlink (IN-01)', () => {
    const reportPath = join(dir, 'symlinked-report.json');
    writeFileSync(
      reportPath,
      JSON.stringify({
        files: { 'src/bar.ts': { mutants: { '0': { killedBy: ['t1'] } } } },
        testFiles: {
          'src/bar.test.ts': {
            tests: [
              { id: 't1', name: 'bar kills' },
              { id: 't2', name: 'bar zero-kill' },
            ],
          },
        },
      }),
    );
    const linkPath = join(dir, 'linked-script.mjs');
    symlinkSync(SCRIPT, linkPath);

    const stdout = execFileSync('node', [linkPath, reportPath], { encoding: 'utf8' });

    expect(stdout).toContain('ZERO-KILL  src/bar.test.ts > bar zero-kill');
  });
});
