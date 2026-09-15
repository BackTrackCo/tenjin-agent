import { afterEach, describe, expect, it, vi } from 'vitest';
import TenjinVitestReporter from './vitest-reporter';

/**
 * The reporter against a structural fake of vitest's reporter API: what it
 * prints, in GitHub's escaping, and nothing when nothing failed. The real run
 * it was checked against is `fixtures/vitest-default.txt`.
 */

interface FakeError {
  name?: string;
  message?: string;
}

function testModule(
  relativeModuleId: string | undefined,
  tests: Array<{ fullName: string; errors?: FakeError[] }>,
  moduleErrors: FakeError[] = [],
) {
  return {
    moduleId: '/home/dev/app/' + (relativeModuleId ?? 'src/x.test.ts'),
    ...(relativeModuleId !== undefined ? { relativeModuleId } : {}),
    errors: () => moduleErrors,
    children: {
      allTests: () =>
        tests.map((t) => ({ fullName: t.fullName, result: () => ({ errors: t.errors ?? [] }) })),
    },
  };
}

function run(modules: ReturnType<typeof testModule>[], unhandled: unknown[] = []): string[] {
  const lines: string[] = [];
  const reporter = new TenjinVitestReporter();
  reporter.onInit({ logger: { log: (message: string) => lines.push(...message.split('\n')) } });
  reporter.onTestRunEnd(modules, unhandled);
  return lines;
}

const ASSERTION = { name: 'AssertionError', message: 'expected 2 to be 1 // Object.is equality' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the tenjin vitest reporter', () => {
  it("prints one ::error line per failed test, named the way vitest's FAIL header names it", () => {
    const lines = run([
      testModule('test/session.test.ts', [
        {
          fullName: 'session > renews',
          errors: [{ ...ASSERTION, message: ASSERTION.message + '\n\n- Expected\n+ Received' }],
        },
      ]),
    ]);
    expect(lines).toEqual([
      '::error title=test/session.test.ts > session > renews::AssertionError: expected 2 to be 1 // Object.is equality',
    ]);
  });

  it('escapes the title and the message the way GitHub reads them back', () => {
    const lines = run([
      testModule('a.test.ts', [
        { fullName: '50% of runs, at 12:00', errors: [{ name: 'Error', message: 'at 100%' }] },
      ]),
    ]);
    expect(lines).toEqual([
      '::error title=a.test.ts > 50%25 of runs%2C at 12%3A00::Error: at 100%25',
    ]);
  });

  it('names a file that failed to import by the file alone, and an unhandled error by nothing', () => {
    const lines = run(
      [
        testModule(
          'test/broken.test.ts',
          [],
          [{ name: 'Error', message: "Cannot find module './x'" }],
        ),
      ],
      [{ name: 'Error', message: 'boom' }],
    );
    expect(lines).toEqual([
      "::error title=test/broken.test.ts::Error: Cannot find module './x'",
      '::error::Error: boom',
    ]);
  });

  it('prints nothing when nothing failed', () => {
    expect(run([testModule('a.test.ts', [])])).toEqual([]);
  });

  it('keeps the last ten failures of a long run', () => {
    const tests = Array.from({ length: 12 }, (_, i) => ({
      fullName: `case ${i + 1}`,
      errors: [ASSERTION],
    }));
    const lines = run([testModule('a.test.ts', tests)]);
    expect(lines).toHaveLength(10);
    expect(lines[0]).toContain('title=a.test.ts > case 3::');
    expect(lines[9]).toContain('title=a.test.ts > case 12::');
  });

  it('cuts a pasted value at 300 characters and a nameless error to its message', () => {
    const [line] = run([
      testModule('a.test.ts', [{ fullName: 'huge', errors: [{ message: 'v'.repeat(1000) }] }]),
    ]);
    expect(line).toBe(
      '::error title=a.test.ts > huge::' + ('Error: ' + 'v'.repeat(1000)).slice(0, 300),
    );
  });

  it('names the file relative to the run when vitest hands it no relativeModuleId', () => {
    const module = {
      ...testModule(undefined, [{ fullName: 'old', errors: [ASSERTION] }]),
      moduleId: process.cwd() + '/src/old.test.ts',
    };
    expect(run([module])[0]).toContain('title=src/old.test.ts > old::');
  });

  it('writes to stdout when vitest hands it no logger', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    new TenjinVitestReporter().onTestRunEnd([
      testModule('a.test.ts', [{ fullName: 'one', errors: [ASSERTION] }]),
    ]);
    expect(write).toHaveBeenCalledWith(
      '::error title=a.test.ts > one::AssertionError: expected 2 to be 1 // Object.is equality\n',
    );
  });
});
