import { describe, expect, it } from 'vitest';
import {
  allowedHeads,
  commandHeads,
  errnoOf,
  errorLine,
  filesInError,
  normalizeForSig,
  saltedCoarse,
  sigV1,
  topFrameFile,
} from './signature';

/**
 * The failure arm's pure half, on the generated arm's own fixtures
 * (`push-scripts.test.ts`, #292's corpus). What matters: which commands the
 * arm fires behind, which line of a runner's output is the failure, and that
 * the keys stay the bytes the team shelf already holds.
 */

const HEX16 = /^[0-9a-f]{16}$/;

describe('the heads allowlist', () => {
  it.each([
    ['cd /x && pnpm test', ['pnpm']],
    ['pnpm test && echo done', ['pnpm']],
    ['sudo -u builder pnpm test', ['pnpm']],
    ['FOO=1 npx tsc --noEmit', ['tsc']],
    ['./node_modules/.bin/vitest run', ['vitest']],
    ['python3 -m pytest tests/', ['pytest']],
    ['node scripts/build.js', ['node']],
    ['pnpm exec vitest run x', ['vitest']],
  ])('fires behind %s', (command, heads) => {
    expect(allowedHeads(command)).toEqual(heads);
  });

  it.each([
    // 14 of 14 historical false positives: source that MENTIONS an errno,
    // read through a pipe.
    'git show HEAD:src/x.ts | grep ENOENT',
    'git log -p | sed -n 1,20p',
    'npm ls zod',
    'node -e "throw new Error()"',
    'python3 -c "import x"',
    'sudo grep pnpm src',
    'echo vitest',
  ])('stays out of %s', (command) => {
    expect(allowedHeads(command)).toEqual([]);
  });

  it('reads the program each segment runs and its first argument', () => {
    expect(commandHeads('timeout 30s pnpm build; go test ./...')).toEqual([
      { head: 'pnpm', sub: 'build' },
      { head: 'go', sub: 'test' },
    ]);
  });
});

describe('the error line', () => {
  const VITEST = [
    ' FAIL  src/date.test.ts > formatDate > handles null',
    'AssertionError: expected undefined to be null',
    '    at Object.<anonymous> (src/date.test.ts:12:5)',
    '',
    ' Test Files  1 failed | 3 passed (4)',
    '      Tests  2 failed | 5 passed (7)',
    '',
  ].join('\n');
  const JEST = [
    ' FAIL  src/date.test.js',
    '  ● formatDate › handles null',
    '',
    '    expect(received).toBe(expected)',
    '    AssertionError: expected undefined to be null',
    '',
    'Test Suites: 1 failed, 3 passed, 4 total',
    'Tests:       1 failed, 5 passed, 6 total',
    '',
  ].join('\n');
  const PYTEST = [
    '=================================== FAILURES ===================================',
    'E       AssertionError: assert 1 == 2',
    '',
    '=========================== short test summary info ============================',
    'FAILED tests/test_date.py::TestDate::test_handles_null - AssertionError: assert 1 == 2',
    '3 failed, 10 passed in 0.42s',
    '',
  ].join('\n');
  const CARGO = [
    'error[E0308]: mismatched types',
    ' --> src/main.rs:4:5',
    '',
    'error: could not compile `demo` due to 2 previous errors',
    '',
  ].join('\n');
  const GO = [
    '--- FAIL: TestFormatDate (0.00s)',
    '    date_test.go:14: expected 1, got 2',
    'FAIL',
    'FAIL\tgithub.com/acme/api/date\t0.021s',
    '',
  ].join('\n');
  const TSC = [
    "src/app.ts(12,3): error TS2304: Cannot find name 'foo'.",
    '',
    'Found 3 errors in 2 files.',
    '',
  ].join('\n');
  const TSC_PRESTEP = [
    '> api@1.0.0 test',
    '> tsc --noEmit && vitest run',
    '',
    "src/app.ts(42,7): error TS2345: argument of type 'string' is not assignable.",
    '',
    'Found 2 errors in 1 file.',
    '',
  ].join('\n');

  it.each([
    ['vitest', VITEST, 'AssertionError: expected undefined to be null'],
    ['jest', JEST, 'AssertionError: expected undefined to be null'],
    [
      'pytest',
      PYTEST,
      'FAILED tests/test_date.py::TestDate::test_handles_null - AssertionError: assert 1 == 2',
    ],
    // rustc's `could not compile … due to N previous errors` is a totals row
    // wearing an error class.
    ['cargo', CARGO, 'error[E0308]: mismatched types'],
    ['go', GO, '--- FAIL: TestFormatDate (0.00s)'],
    ['tsc', TSC, "src/app.ts(12,3): error TS2304: Cannot find name 'foo'."],
    [
      'a tsc pre-step inside pnpm test',
      TSC_PRESTEP,
      "src/app.ts(42,7): error TS2345: argument of type 'string' is not assignable.",
    ],
  ])('picks the specific line over the totals row for %s', (_name, out, want) => {
    expect(errorLine(out)?.line).toBe(want);
  });

  it('yields nothing from a totals-only output: a key on "2 failed" is every repo on earth', () => {
    const totals = [
      ' Test Files  1 failed | 3 passed (4)',
      '      Tests  2 failed | 5 passed (7)',
      '',
    ];
    expect(errorLine(totals.join('\n'))).toBeNull();
  });

  it('anchors the block to the failure, so a frame from another failure cannot key it', () => {
    const two = [
      ' FAIL  src/a.test.ts > one',
      'TypeError: x is not a function',
      '    at Object.<anonymous> (src/a.test.ts:3:1)',
      '',
      ' FAIL  src/b.test.ts > two',
      'AssertionError: expected 1 to be 2',
      '',
      ' Test Files  2 failed (2)',
      '',
    ].join('\n');
    const found = errorLine(two);
    expect(found?.line).toBe('AssertionError: expected 1 to be 2');
    expect(found?.block).not.toContain('a.test.ts');
    expect(sigV1(found?.line ?? '', found?.block ?? '')).toBeNull();
  });

  it('is silent on output with no marker at all', () => {
    expect(errorLine('all 12 tests passed\n')).toBeNull();
  });
});

describe('sig_v1', () => {
  const ENOENT = "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'";
  const ENOENT_BLOCK = ENOENT + '\n    at run (src/migrate.ts:12:3)\n';

  it('is two 16-hex keys, the coarse one dropping the frame', () => {
    const sig = sigV1(ENOENT, ENOENT_BLOCK);
    expect(sig?.key).toMatch(HEX16);
    expect(sig?.coarseKey).toMatch(HEX16);
    expect(sig?.key).not.toBe(sig?.coarseKey);
    // The same errno raised from a sibling file shares the coarse key only.
    const sibling = sigV1(ENOENT, ENOENT + '\n    at run (src/seed.ts:4:1)\n');
    expect(sibling?.key).not.toBe(sig?.key);
    expect(sibling?.coarseKey).toBe(sig?.coarseKey);
  });

  it('keys the same bytes on two machines: paths, digits, hosts and hex normalized', () => {
    const a = sigV1(
      "Error: ENOENT: no such file, open '/Users/ali/proj/drizzle.config.ts' (line 12)",
      '    at run (/Users/ali/proj/src/migrate.ts:12:3)',
    );
    const b = sigV1(
      "Error: ENOENT: no such file, open '/home/bo/work/drizzle.config.ts' (line 40)",
      '    at run (/home/bo/work/src/migrate.ts:99:1)',
    );
    expect(a?.key).toBe(b?.key);
  });

  it('is below the floor with neither an errno nor a frame', () => {
    expect(sigV1('Tests  2 failed | 5 passed (7)', 'Tests  2 failed | 5 passed (7)')).toBeNull();
    // The word ERROR is not an errno: the whitelist, not a shape.
    expect(sigV1('ERROR: 2 tests failed', 'ERROR: 2 tests failed')).toBeNull();
  });

  it('has no coarse key when the frame alone cleared the floor', () => {
    const sig = sigV1(
      'AssertionError: expected 1 to be 2',
      'AssertionError: expected 1 to be 2\n    at src/a.test.ts:3:1',
    );
    expect(sig?.key).toMatch(HEX16);
    expect(sig?.coarseKey).toBeNull();
  });

  it.each([
    ['ERR_PNPM_OUTDATED_LOCKFILE  Cannot install', 'ERR_PNPM_OUTDATED_LOCKFILE'],
    ["error TS2345: Argument of type 'string'", 'TS2345'],
    ['error[E0308]: mismatched types', 'E0308'],
    ['listen EADDRINUSE: address already in use', 'EADDRINUSE'],
    ['ESLINT found 2 EXPECTED problems', ''],
  ])('reads the errno off %s', (line, errno) => {
    expect(errnoOf(line)).toBe(errno);
  });

  it.each([
    ['    at run (/a/b/file.ts:12:3)', 'file.ts'],
    ['  File "/a/b.py", line 3', 'b.py'],
    ['src/x.ts(12,3): error TS2304', 'x.ts'],
    [' --> src/main.rs:4:5', 'main.rs'],
    ['no frame here', ''],
  ])('reduces the top frame of %s to a basename', (text, frame) => {
    expect(topFrameFile(text)).toBe(frame);
  });

  it('normalizes env-var names before digits, so ERR_MODULE_NOT_FOUND is one token', () => {
    expect(normalizeForSig('ERR_MODULE_NOT_FOUND at /a/b/c.js:12 on host.acme.io')).toBe(
      'e at @/:n on h',
    );
  });

  it('names the files the error itself did, and never an evaluated string', () => {
    expect(
      filesInError(
        'src/app.ts(12,3): error\n    at run (src/migrate.ts:12:3)\n  File "<string>", line 1',
      ),
    ).toEqual(['app.ts', 'migrate.ts']);
  });

  it("salts the coarse key with the repo the way `tenjin sync` does: state-store's pinned value", () => {
    expect(saltedCoarse('abc123', 'https://github.com/acme/widgets.git')).toBe('a7b33a270638732d');
    expect(saltedCoarse('abc123', 'repo-a')).not.toBe(saltedCoarse('abc123', 'repo-b'));
  });
});
