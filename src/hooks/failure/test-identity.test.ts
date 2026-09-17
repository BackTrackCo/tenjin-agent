import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { testFailuresOf } from './test-identity';

/**
 * Which tests a failed command's output names, and the line each failed on:
 * the tenjin reporter's `::error` lines and vitest's `FAIL` header, both read
 * straight off the output. The fixtures are one real vitest 4.1.10 run of six
 * files (four failing tests, a file that fails to import, an unhandled
 * rejection), kept the way the failure arm reads a Bash call: stdout, then
 * stderr.
 */

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const NAMES = [
  'test/helper.test.ts > helpers > fails inside a named helper',
  'test/session expiry.test.ts > expires after the window',
  'test/session.test.ts > session > renews session, restarting the maxAge window',
  'test/store.test.ts > store > loads a user',
];

const named = (text: string) => testFailuresOf(text).filter((f) => f.name !== '');
const unowned = (text: string) => testFailuresOf(text).filter((f) => f.name === '');

describe('testFailuresOf', () => {
  it('reads every failing test off the reporter lines of a real run, with its line', () => {
    const got = named(fixture('vitest-default.txt'));
    expect(got.map((f) => f.name)).toEqual(NAMES);
    expect(got.map((f) => f.line)).toEqual([
      'AssertionError: expected 2 to be 1 // Object.is equality',
      'AssertionError: expected 2 to be 1 // Object.is equality',
      "AssertionError: expected { id: '2', data: { foo: 'bar' } } to match object { id: '1' }",
      "TypeError: Cannot read properties of undefined (reading 'id')",
    ]);
  });

  it('keeps an import failure and an unhandled rejection as lines no test owns', () => {
    const lines = unowned(fixture('vitest-default.txt')).map((f) => f.line);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Error: Cannot find module '\.\/does-not-exist'/);
    expect(lines[1]).toBe('Error: boom from an unawaited promise');
  });

  it('still names them through `2>&1 | tail -5`, where every assertion above is gone', () => {
    const tail = fixture('vitest-tail5.txt');
    // Every line left is a reporter line; the printed assertions are gone.
    expect(tail.split('\n').filter((line) => line !== '' && !line.startsWith('::'))).toEqual([]);
    expect(named(tail).map((f) => f.name)).toEqual(NAMES);
  });

  it("reads the agent reporter's run the same way", () => {
    expect(named(fixture('vitest-agent.txt')).map((f) => f.name)).toEqual(NAMES);
  });

  it("names a test from the console header alone, project label off, in the reporter line's bytes", () => {
    const run = fixture('vitest-projects.txt');
    expect(run).toContain(
      ' FAIL  |node| test/helper.test.ts > helpers > fails inside a named helper',
    );
    const consoleOnly = run
      .split('\n')
      .filter((line) => !line.startsWith('::'))
      .join('\n');
    // The same four names from either source, so a teammate who ran without the
    // reporter and one who ran through `tail` ask under one key.
    expect(named(consoleOnly).map((f) => f.name)).toEqual(NAMES);
    expect(named(run).map((f) => f.name)).toEqual(NAMES);
    // A header names the test and nothing else.
    expect(named(consoleOnly).every((f) => f.line === '')).toBe(true);
  });

  it('takes a colour badge off a header, and keeps a path with a space in it', () => {
    expect(named(' FAIL   node  src/a.test.ts > suite > one\n').map((f) => f.name)).toEqual([
      'src/a.test.ts > suite > one',
    ]);
    expect(
      named(' FAIL  test/session expiry.test.ts > expires after the window\n').map((f) => f.name),
    ).toEqual(['test/session expiry.test.ts > expires after the window']);
  });

  it("reads vitest's own GitHub reporter: project prefix off, the printed error down to its first line", () => {
    const line =
      '::error file=/home/dev/app/src/a.test.ts,title=[node] src/a.test.ts > suite > one,line=3,column=9' +
      '::AssertionError: expected 1 to be 2%0A%0A- Expected%0A+ Received';
    expect(testFailuresOf(line)).toEqual([
      { name: 'src/a.test.ts > suite > one', line: 'AssertionError: expected 1 to be 2' },
    ]);
  });

  it('unescapes a name the way GitHub escaped it', () => {
    const line = '::error title=a.test.ts > 50%25 of runs%2C at 12%3A00::Error: x\n';
    expect(named(line).map((f) => f.name)).toEqual(['a.test.ts > 50% of runs, at 12:00']);
  });

  it('makes no name out of a lint rule, jest, or a file that failed to import', () => {
    const out = [
      '::error file=src/a.ts,line=1,col=1,title=no-unused-vars::x is assigned a value but never used',
      // jest leaves `:` unescaped in a title; one colon is still not the split.
      '::error file=a.test.js,title=suite › works: yes::Error: x',
      ' FAIL  src/sum.test.js',
      '  ● math › adds 1 + 2 to equal 3',
      ' FAIL  test/broken.test.ts [ test/broken.test.ts ]',
    ].join('\n');
    expect(named(out)).toEqual([]);
    expect(unowned(out).map((f) => f.line)).toEqual([
      'x is assigned a value but never used',
      'Error: x',
    ]);
  });

  it('is empty on output that names nothing', () => {
    expect(testFailuresOf('all 12 tests passed\n')).toEqual([]);
  });
});
