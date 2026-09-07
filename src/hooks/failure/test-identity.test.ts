import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sigV1Test, testIdentityOf } from './test-identity';

/**
 * The test-identity lane: the artifact within this command's window first,
 * the console header second, a guess never.
 */

const NOW = 1_700_000_000_000;
const CONSOLE = [
  ' FAIL  src/a.test.ts > suite > one',
  'AssertionError: expected 1 to be 2',
  '',
  ' FAIL  src/date.test.ts > formatDate > handles null',
  'AssertionError: expected undefined to be null',
  '',
].join('\n');

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'tenjin-d-testid-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function report(
  startTime: number,
  failed: Array<Record<string, string>>,
  rel = '.vitest-report.json',
) {
  writeFileSync(join(cwd, rel), JSON.stringify({ startTime, endTime: startTime + 900, failed }));
}

describe('testIdentityOf', () => {
  it("reads the LAST failure off a report written inside this command's window", async () => {
    report(NOW + 10, [
      { file: join(cwd, 'src/a.test.ts'), suite: 'suite', test: 'one' },
      { file: join(cwd, 'src/b.test.ts'), suite: 'outer > inner', test: 'two' },
    ]);
    await expect(testIdentityOf('', cwd, NOW, 'pnpm vitest run')).resolves.toEqual({
      file: 'src/b.test.ts',
      suite: 'outer > inner',
      test: 'two',
    });
  });

  it('ignores a report from the run before this command, and falls back to the console', async () => {
    report(NOW - 10, [{ file: join(cwd, 'src/old.test.ts'), suite: 's', test: 'stale' }]);
    await expect(testIdentityOf(CONSOLE, cwd, NOW, 'pnpm vitest run')).resolves.toEqual({
      file: 'src/date.test.ts',
      suite: 'formatDate',
      test: 'handles null',
    });
  });

  it('reads no artifact with no bashstart mark to check it against', async () => {
    report(NOW + 10, [{ file: join(cwd, 'src/a.test.ts'), suite: 's', test: 'one' }]);
    await expect(testIdentityOf('', cwd, null, 'pnpm vitest run')).resolves.toBeNull();
  });

  it('trusts the artifact only for a single-segment command', async () => {
    report(NOW + 10, [{ file: join(cwd, 'src/a.test.ts'), suite: 's', test: 'one' }]);
    await expect(testIdentityOf('', cwd, NOW, 'pnpm build && pnpm test')).resolves.toBeNull();
    await expect(testIdentityOf('', cwd, NOW, 'pnpm test 2>&1')).resolves.not.toBeNull();
  });

  it("reads the report path the repo's own config names for the tenjin reporter", async () => {
    writeFileSync(
      join(cwd, 'vitest.config.ts'),
      "export default { test: { reporters: ['default', ['./tenjin-vitest-reporter.mjs', { outputFile: 'out/report.json' }]] } };",
    );
    writeFileSync(join(cwd, '.vitest-report.json'), '{}');
    mkdirSync(join(cwd, 'out'));
    report(
      NOW + 10,
      [{ file: join(cwd, 'src/c.test.ts'), suite: '', test: 'three' }],
      'out/report.json',
    );
    await expect(testIdentityOf('', cwd, NOW, 'pnpm test')).resolves.toEqual({
      file: 'src/c.test.ts',
      suite: '',
      test: 'three',
    });
  });

  it('yields nothing from a bare FAIL line with no breadcrumb', async () => {
    await expect(testIdentityOf('FAIL  some suite\n', cwd, NOW, 'pnpm test')).resolves.toBeNull();
  });
});

describe('sigV1Test', () => {
  it('keys file, suite and test together, 16 hex', () => {
    const a = sigV1Test({ file: 'src/a.test.ts', suite: 's', test: 'one' });
    const b = sigV1Test({ file: 'src/a.test.ts', suite: 's', test: 'two' });
    expect(a.key).toMatch(/^[0-9a-f]{16}$/);
    expect(a.key).not.toBe(b.key);
    expect(a.file).toBe('src/a.test.ts');
  });
});
