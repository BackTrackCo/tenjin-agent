import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allowedHeads, commandHeads, errnoOf, errorLine } from './signature';

/**
 * The failure arm's pure half. What matters: which commands the arm fires
 * behind, and which line of a runner's output is the failure, judged one line
 * at a time with no model of how the runner lays out its page.
 */

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

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
    expect(errorLine(out)).toBe(want);
  });

  it('yields nothing from totals alone: "2 failed" is every repo on earth', () => {
    const totals = [
      ' Test Files  1 failed | 3 passed (4)',
      '      Tests  2 failed | 5 passed (7)',
      '',
    ];
    expect(errorLine(totals.join('\n'))).toBeNull();
  });

  const ENOENT_LINE = "Error: ENOENT: no such file or directory, open '/repo/fixtures/a.json'";
  const spliced = (blanks: number): string =>
    [
      ' FAIL  src/thing.test.ts > loads config',
      ENOENT_LINE,
      '    at readFileSync (node:fs:1234:5)',
      ...Array.from({ length: blanks }, () => ''),
      ' Test Files  1 failed (1)',
      '      Tests  1 failed (1)',
      '',
    ].join('\n');

  // The arm joins stdout, stderr, `error` and `text` with a newline apiece, so
  // blank lines between a failure and its totals are a splice artifact. With no
  // blocks there is no gap to measure: the output is one command's.
  it.each([0, 1, 2, 5, 30])('reads the line across %i blank lines', (blanks) => {
    expect(errorLine(spliced(blanks))).toBe(ENOENT_LINE);
  });

  it('yields nothing when nothing above the totals is a diagnostic', () => {
    const banner = [
      '> api@1.0.0 test',
      '> vitest run',
      '',
      '',
      ' Test Files  1 failed (1)',
      '      Tests  1 failed (1)',
      '',
    ];
    expect(errorLine(banner.join('\n'))).toBeNull();
  });

  it("reads an earlier diagnostic in the same output as this command's", () => {
    // One Bash call's own streams: `pnpm build && pnpm test` prints both halves
    // into it, and the last diagnostic in it is this call's, however far up.
    const out = [
      "Error: EACCES: permission denied, open '/etc/hosts'",
      '    at open (node:fs:9:9)',
      ...Array.from({ length: 200 }, (_, n) => `  transform src/mod${n}.ts (ok)`),
      ' Test Files  1 failed (1)',
      '      Tests  1 failed (1)',
      '',
    ].join('\n');
    expect(errorLine(out)).toBe("Error: EACCES: permission denied, open '/etc/hosts'");
  });

  it("prefers the tool's own diagnostic to the package manager's verdict", () => {
    const tscUnderPnpm = [
      '> app@1.0.0 typecheck /home/dev/app',
      '> tsc --noEmit',
      '',
      "src/a.ts(12,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
      ' ELIFECYCLE  Command failed with exit code 2.',
      '',
    ].join('\n');
    expect(errorLine(tscUnderPnpm)).toBe(
      "src/a.ts(12,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    );
    // With nothing else to say, the verdict is still a line.
    expect(errorLine(' ELIFECYCLE  Command failed with exit code 2.\n')).toBe(
      'ELIFECYCLE  Command failed with exit code 2.',
    );
  });

  // Failure blocks verbatim from a vitest 4.1.10 run (`fixtures/vitest-default.txt`).
  // Each has `❯` pointers under its assertion, which the block walker this
  // replaces read as the start of a new failure.
  const NAMED_HELPER = [
    ' FAIL  test/helper.test.ts > helpers > fails inside a named helper',
    'AssertionError: expected 2 to be 1 // Object.is equality',
    '',
    '- Expected',
    '+ Received',
    '',
    '- 1',
    '+ 2',
    '',
    ' ❯ checkThing test/helper.test.ts:2:13',
    '      1| function checkThing(x: number): void {',
    '      2|   expect(x).toBe(1);',
    '       |             ^',
    '      3| }',
    "      4| describe('helpers', () => {",
    ' ❯ test/helper.test.ts:6:5',
    '',
    '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/5]⎯',
    '',
  ];
  const SPACE_IN_PATH = [
    ' FAIL  test/session expiry.test.ts > expires after the window',
    'AssertionError: expected 2 to be 1 // Object.is equality',
    '',
    ' ❯ test/session expiry.test.ts:2:13',
    "      1| test('expires after the window', () => {",
    '      2|   expect(2).toBe(1);',
    '       |             ^',
    '',
  ];
  const THROWN_IN_APP = [
    ' FAIL  test/store.test.ts > store > loads a user',
    "TypeError: Cannot read properties of undefined (reading 'id')",
    ' ❯ load src/store.ts:2:40',
    '      1| export function load(u: { profile?: { id: string } }): string {',
    '      2|   return (u.profile as { id: string }).id;',
    '       |                                        ^',
    ' ❯ test/store.test.ts:4:5',
    '',
  ];
  const TOTALS = [' Test Files  1 failed (1)', '      Tests  1 failed (1)', ''];

  it.each([
    [
      'an assertion in a named helper',
      NAMED_HELPER,
      'AssertionError: expected 2 to be 1 // Object.is equality',
    ],
    [
      'a test file path with a space',
      SPACE_IN_PATH,
      'AssertionError: expected 2 to be 1 // Object.is equality',
    ],
    [
      'a TypeError thrown in app code',
      THROWN_IN_APP,
      "TypeError: Cannot read properties of undefined (reading 'id')",
    ],
  ])("reaches the assertion through vitest's stack pointers: %s", (_name, block, want) => {
    expect(errorLine([...block, ...TOTALS].join('\n'))).toBe(want);
  });

  it('reads a whole real run, pointers and gutters and all, to its last diagnostic', () => {
    // stdout then stderr, as the arm joins them: the unhandled rejection is
    // the last diagnostic vitest printed.
    expect(errorLine(fixture('vitest-default.txt'))).toBe('Error: boom from an unawaited promise');
  });

  it('never takes a code-frame gutter that quotes a throw', () => {
    const out = [
      "Error: ENOENT: no such file or directory, open 'a.json'",
      '    > 11 |   throw new Error("boom")',
      '         |         ^',
      '',
    ].join('\n');
    expect(errorLine(out)).toBe("Error: ENOENT: no such file or directory, open 'a.json'");
  });

  it('never takes a `::` annotation line, which the arm reads on its own', () => {
    const out = 'Error: real one\n::error title=a.test.ts > s > t::AssertionError: x\n';
    expect(errorLine(out)).toBe('Error: real one');
  });

  it('is silent on output with no marker at all', () => {
    expect(errorLine('all 12 tests passed\n')).toBeNull();
  });
});

describe('errnoOf', () => {
  it.each([
    ['ERR_PNPM_OUTDATED_LOCKFILE  Cannot install', 'ERR_PNPM_OUTDATED_LOCKFILE'],
    ["error TS2345: Argument of type 'string'", 'TS2345'],
    ['error[E0308]: mismatched types', 'E0308'],
    ['listen EADDRINUSE: address already in use', 'EADDRINUSE'],
    ['ESLINT found 2 EXPECTED problems', ''],
  ])('reads the errno off %s', (line, errno) => {
    expect(errnoOf(line)).toBe(errno);
  });
});
