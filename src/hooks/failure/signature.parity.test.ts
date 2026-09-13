import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { errorLine, normalizeForSig, sigV1 } from './signature';
import { sigV1Test, testIdentityOf } from './test-identity';

/**
 * The benchmark's seeded arm publishes its lesson under the `sig_v1` key the
 * consumer's failure fire will resolve, and computes that key in Python
 * (`evals/benchmark/signature.py`), a port of this module. Both sides run here
 * over the same outputs: the runner shapes `signature.test.ts` freezes, the
 * floor cases, and the two failures the Bench-1 fixture actually prints. A
 * byte of drift between the port and this file fails this suite.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const OUTPUTS: Record<string, string> = {
  vitest: [
    ' FAIL  src/date.test.ts > formatDate > handles null',
    'AssertionError: expected undefined to be null',
    '    at Object.<anonymous> (src/date.test.ts:12:5)',
    '',
    ' Test Files  1 failed | 3 passed (4)',
    '      Tests  2 failed | 5 passed (7)',
    '',
  ].join('\n'),
  jest: [
    ' FAIL  src/date.test.js',
    '  ● formatDate › handles null',
    '',
    '    expect(received).toBe(expected)',
    '    AssertionError: expected undefined to be null',
    '',
    'Test Suites: 1 failed, 3 passed, 4 total',
    'Tests:       1 failed, 5 passed, 6 total',
    '',
  ].join('\n'),
  pytest: [
    '=================================== FAILURES ===================================',
    'E       AssertionError: assert 1 == 2',
    '',
    '=========================== short test summary info ============================',
    'FAILED tests/test_date.py::TestDate::test_handles_null - AssertionError: assert 1 == 2',
    '3 failed, 10 passed in 0.42s',
    '',
  ].join('\n'),
  cargo: [
    'error[E0308]: mismatched types',
    ' --> src/main.rs:4:5',
    '',
    'error: could not compile `demo` due to 2 previous errors',
    '',
  ].join('\n'),
  go: [
    '--- FAIL: TestFormatDate (0.00s)',
    '    date_test.go:14: expected 1, got 2',
    'FAIL',
    'FAIL\tgithub.com/acme/api/date\t0.021s',
    '',
  ].join('\n'),
  tsc: [
    "src/app.ts(12,3): error TS2304: Cannot find name 'foo'.",
    '',
    'Found 3 errors in 2 files.',
    '',
  ].join('\n'),
  totalsOnly: [
    ' Test Files  1 failed | 3 passed (4)',
    '      Tests  2 failed | 5 passed (7)',
    '',
  ].join('\n'),
  twoBlocks: [
    ' FAIL  src/a.test.ts > one',
    'TypeError: x is not a function',
    '    at Object.<anonymous> (src/a.test.ts:3:1)',
    '',
    ' FAIL  src/b.test.ts > two',
    'AssertionError: expected 1 to be 2',
    '',
    ' Test Files  2 failed (2)',
    '',
  ].join('\n'),
  noMarker: 'all 12 tests passed\n',
  enoent: [
    "Error: ENOENT: no such file, open '/Users/ali/proj/drizzle.config.ts' (line 12)",
    '    at run (/Users/ali/proj/src/migrate.ts:12:3)',
    '',
  ].join('\n'),
  // The Bench-1 fixture's trap: `pnpm test -- tests/actor.test.mjs` runs every
  // shard, and the tail is totals with nothing specific above it in its block.
  fixtureTrap: [
    ' FAIL  unrelated/shard-3.test.mjs > integration shard 3',
    'Error: fixture database unavailable at worker 3',
    ' ❯ unrelated/shard-3.test.mjs:4:9',
    '      2| ',
    "      3| test('integration shard 3', () => {",
    "      4|   throw new Error('fixture database unavailable at worker 3');",
    '       |         ^',
    '      5| });',
    '      6| ',
    '',
    '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯',
    '',
    '',
    ' Test Files  4 failed (4)',
    '      Tests  4 failed | 1 passed (5)',
    '   Start at  23:08:01',
    '   Duration  378ms (transform 31ms, setup 0ms, collect 59ms, tests 32ms, environment 1ms, prepare 244ms)',
    '',
    'all-tests: running every project; file arguments are not forwarded',
    '[31m[ELIFECYCLE][39m Test failed. See above for more details.',
    '',
  ].join('\n'),
  // The fixture's assertion on the unfixed source: below the sig_v1 floor, keyed
  // by the product on the test identity vitest's FAIL header names.
  fixtureAssertion: [
    ' FAIL  tests/actor.test.mjs > actorKey case 1',
    "AssertionError: expected 's1:undefined' to be 's1:root' // Object.is equality",
    '',
    'Expected: "s1:root"',
    'Received: "s1:undefined"',
    '',
    ' ❯ tests/actor.test.mjs:5:12',
    '',
    ' Test Files  1 failed (1)',
    '      Tests  1 failed | 1 passed (2)',
    '',
  ].join('\n'),
  nestedSuite: [
    ' FAIL  src/a.test.ts > outer > inner > two',
    'AssertionError: expected 1 to be 2',
    '',
  ].join('\n'),
  bareFail: 'FAIL  some suite\n',
  // The fixture's refusal: `npx vitest run` reaches the config with no pnpm agent.
  // A real run's top frame is vite's temporary config bundle, named with a
  // timestamp, so the key changes every run; the frame here is fixed so the
  // parity check is deterministic.
  fixtureRefusal: [
    'failed to load config from /tmp/trial/repo/vitest.config.mjs',
    '',
    '',
    "Error: this repository's tests run through pnpm; see the repository convention",
    '    at file:///tmp/trial/repo/vitest.config.mjs:5:9',
    '    at ModuleJob.run (node:internal/modules/esm/module_job:377:25)',
    '',
  ].join('\n'),
};

interface Ported {
  line: string | null;
  block: string | null;
  key: string | null;
  identity: { file: string; suite: string; test: string } | null;
  test_key: string | null;
}

function ported(): Ported[] {
  const stdout = execFileSync('python3', ['-m', 'evals.benchmark.signature'], {
    cwd: REPO_ROOT,
    input: JSON.stringify(Object.values(OUTPUTS).map((text) => ({ text }))),
    encoding: 'utf8',
  });
  return JSON.parse(stdout) as Ported[];
}

describe('the Python port of sig_v1 agrees with this module', () => {
  const results = ported();
  const names = Object.keys(OUTPUTS);

  it.each(names.map((name, index) => [name, index]))('on %s', (name, index) => {
    const text = OUTPUTS[name as string] ?? '';
    const found = errorLine(text);
    const port = results[index as number];
    expect(port?.line).toBe(found?.line ?? null);
    expect(port?.block).toBe(found?.block ?? null);
    const key = found === null ? null : (sigV1(found.line, found.block)?.key ?? null);
    expect(port?.key).toBe(key);
  });

  it.each(names.map((name, index) => [name, index]))(
    'on the test identity of %s',
    async (name, index) => {
      const text = OUTPUTS[name as string] ?? '';
      // An empty cwd skips the artifact leg, which the fixtures never carry.
      const identity = await testIdentityOf(text, '', null, 'pnpm exec vitest run');
      const port = results[index as number];
      expect(port?.identity).toEqual(identity);
      expect(port?.test_key).toBe(identity === null ? null : sigV1Test(identity).key);
    },
  );

  it('keys the fixture assertion on its test identity to the value the fires table recorded', () => {
    const assertion = results[names.indexOf('fixtureAssertion')];
    expect(assertion?.key).toBeNull();
    expect(assertion?.test_key).toBe('502b90852a1505e3');
  });

  it('keys the fixture refusal and nothing on the fixture trap', () => {
    const trap = results[names.indexOf('fixtureTrap')];
    const refusal = results[names.indexOf('fixtureRefusal')];
    expect(trap?.key).toBeNull();
    expect(refusal?.key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('normalizes the same bytes', () => {
    const line = 'ERR_MODULE_NOT_FOUND at /a/b/c.js:12 on host.acme.io  Café   x';
    const stdout = execFileSync('python3', ['-m', 'evals.benchmark.signature'], {
      cwd: REPO_ROOT,
      input: JSON.stringify([{ line, block: line }]),
      encoding: 'utf8',
    });
    const [port] = JSON.parse(stdout) as { normalized: string }[];
    expect(port?.normalized).toBe(normalizeForSig(line));
  });
});
