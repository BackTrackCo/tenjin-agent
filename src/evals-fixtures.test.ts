import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildProgram } from './cli';
import type { Io } from './lib/output';

// The eval fixtures under evals/ are graded by a model, on demand, at real cost
// (evals/README.md). Nothing here runs one. These are the free checks: that the
// files parse, that the trigger set stays balanced, and above all that every
// `tenjin <verb>` an expectation grades is still a verb the CLI registers — so a
// command rename turns into a red build here rather than an expectation that
// quietly grades a command nobody will ever run.

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../evals/${path}`, import.meta.url)), 'utf8');

interface EvalCase {
  id: number;
  prompt: string;
  expected_output: string;
  files: string[];
  expectations: string[];
}

interface EvalFile {
  skill_name: string;
  evals: EvalCase[];
}

interface TriggerCase {
  query: string;
  should_trigger: boolean;
  rationale: string;
}

const OUTPUT_FILES = ['tenjin-search/evals.json', 'tenjin-publish/evals.json'] as const;

function registeredVerbs(): Set<string> {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  const io: Io = { stdout: sink, stderr: sink, isTTY: false };
  const program = buildProgram(io, () => {});
  const verbs = new Set<string>();
  for (const command of program.commands) {
    verbs.add(command.name());
    for (const sub of command.commands) verbs.add(`${command.name()} ${sub.name()}`);
  }
  return verbs;
}

// Only backtick-quoted invocations: `tenjin lookup`, `tenjin candidate add`. The
// leading backtick is what keeps prose like "the tenjin repo" out of the match.
function quotedInvocations(text: string): string[] {
  return [...text.matchAll(/`tenjin ((?:[a-z][a-z0-9-]*)(?: [a-z][a-z0-9-]*)?)/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
}

describe('eval fixtures', () => {
  it.each(OUTPUT_FILES)('%s parses with unique ids and non-empty expectations', (path) => {
    const parsed = JSON.parse(read(path)) as EvalFile;
    expect(parsed.skill_name).toBe(path.split('/')[0]);
    expect(parsed.evals.length).toBeGreaterThan(0);

    const ids = parsed.evals.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const c of parsed.evals) {
      expect(c.prompt.length, `case ${c.id} prompt`).toBeGreaterThan(0);
      expect(c.expected_output.length, `case ${c.id} expected_output`).toBeGreaterThan(0);
      expect(Array.isArray(c.files), `case ${c.id} files`).toBe(true);
      expect(c.expectations.length, `case ${c.id} expectations`).toBeGreaterThan(0);
    }
  });

  it('trigger set is balanced and free of duplicate queries', () => {
    const cases = JSON.parse(read('tenjin-search/trigger-eval.json')) as TriggerCase[];
    const positives = cases.filter((c) => c.should_trigger);

    expect(cases.length).toBe(20);
    expect(positives.length).toBe(cases.length - positives.length);
    expect(new Set(cases.map((c) => c.query)).size).toBe(cases.length);
    for (const c of cases) expect(c.rationale.length, c.query).toBeGreaterThan(0);
  });

  // The drift guard. A fixture may only name a command the CLI actually has.
  it('every tenjin command named in a fixture or the README is registered', () => {
    const verbs = registeredVerbs();
    const sources = [...OUTPUT_FILES, 'tenjin-search/trigger-eval.json', 'README.md'];

    for (const path of sources) {
      for (const invocation of quotedInvocations(read(path))) {
        const verb = invocation.split(' ')[0] ?? invocation;
        const known = verbs.has(invocation) || verbs.has(verb);
        expect(
          known,
          `${path} names \`tenjin ${invocation}\`, which the CLI does not register`,
        ).toBe(true);
      }
    }
  });
});
