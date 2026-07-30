import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildProgram } from './cli';
import { searchCandidateSchema } from './lib/agent-api';
import type { Io } from './lib/output';

// The eval fixtures under evals/ are graded by a model, on demand, at real cost
// (evals/README.md). Nothing here runs one. These are the free checks: that the
// files parse, that the trigger set stays balanced, and above all that every
// `tenjin <verb>` an expectation grades is still a verb the CLI registers — so a
// command rename turns into a red build here rather than an expectation that
// quietly grades a command nobody will ever run.
//
// This file is the home for every "shipped text must follow the code" guard, so
// the skill docs are checked here too. Prose that describes the wire is the part
// that rots silently: nothing executes it, and an agent reading a stale field
// list is misled at exactly the moment it is deciding what to buy.

const EVALS_DIR = fileURLToPath(new URL('../evals/', import.meta.url));
const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));

const read = (path: string): string => readFileSync(`${EVALS_DIR}${path}`, 'utf8');

/**
 * Every `.json` and `.md` under `evals/`, relative to it. Walked rather than
 * listed: a hardcoded list guards whatever it happens to name, and the day
 * someone adds a fixture it guards less than it claims while staying green.
 */
function walkFixtures(dir = EVALS_DIR, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return walkFixtures(`${dir}${entry.name}/`, `${prefix}${entry.name}/`);
    return /\.(json|md)$/.test(entry.name) ? [`${prefix}${entry.name}`] : [];
  });
}

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

const SOURCES = walkFixtures();

// Verbs the CLI has retired, and what replaced them. The invocation check below
// only sees backtick-quoted commands, so on its own it reddens the build for
// `tenjin lookup` while leaving "the lookup command includes --json" standing.
// This sweeps the prose too, which is the half a rename actually forgets.
const RETIRED_VERBS: ReadonlyArray<{ verb: string; replacement: string }> = [
  { verb: 'lookup', replacement: 'search' },
];

// `scripts/eval-lookup-recall.ts` is a script in the tenjin repo, not a CLI verb,
// and it kept its name through the search rename.
const RETIRED_EXEMPT = /eval-lookup-recall/g;

interface Registry {
  /** Top-level verbs: `search`, `publish`, `candidate`. */
  verbs: Set<string>;
  /** Two-word forms: `candidate add`, `config set`. */
  pairs: Set<string>;
  /** Verbs that own subcommands, so a bare first word proves nothing. */
  parents: Set<string>;
}

function registry(): Registry {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  const io: Io = { stdout: sink, stderr: sink, isTTY: false };
  const program = buildProgram(io, () => {});
  const reg: Registry = { verbs: new Set(), pairs: new Set(), parents: new Set() };
  for (const command of program.commands) {
    reg.verbs.add(command.name());
    if (command.commands.length > 0) reg.parents.add(command.name());
    for (const sub of command.commands) reg.pairs.add(`${command.name()} ${sub.name()}`);
  }
  return reg;
}

// Only backtick-quoted invocations: `tenjin search`, `tenjin candidate add`. The
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

    // Both sides of the assertion above come from evals/, so on its own it
    // would stay green while the fixtures point at a skill nobody ships.
    expect(
      existsSync(`${SKILLS_DIR}${parsed.skill_name}/SKILL.md`),
      `${path} grades skills/${parsed.skill_name}/SKILL.md, which does not exist`,
    ).toBe(true);

    const ids = parsed.evals.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const c of parsed.evals) {
      expect(c.prompt.length, `case ${c.id} prompt`).toBeGreaterThan(0);
      expect(c.expected_output.length, `case ${c.id} expected_output`).toBeGreaterThan(0);
      expect(Array.isArray(c.files), `case ${c.id} files`).toBe(true);
      expect(c.expectations.length, `case ${c.id} expectations`).toBeGreaterThan(0);
      // A seeded file the harness cannot find makes the case silently untestable.
      for (const f of c.files) {
        expect(existsSync(`${EVALS_DIR}${f}`), `case ${c.id} seeds missing file ${f}`).toBe(true);
      }
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
    const reg = registry();

    for (const path of SOURCES) {
      for (const invocation of quotedInvocations(read(path))) {
        const verb = invocation.split(' ')[0] ?? invocation;
        // A verb that owns subcommands proves nothing on its own: `candidate`
        // is registered whether or not `candidate frobnicate` is, so a two-word
        // form has to match as a pair rather than falling back to the first
        // word. The bare group name is still a legitimate thing for prose to
        // name, so it passes on its own.
        const known = reg.parents.has(verb)
          ? invocation === verb || reg.pairs.has(invocation)
          : reg.verbs.has(verb);
        expect(
          known,
          `${path} names \`tenjin ${invocation}\`, which the CLI does not register`,
        ).toBe(true);
      }
    }
  });

  // The prose half of the same guard: a retired verb has to be gone from the
  // sentences and the fenced blocks too, not just from the quoted invocations.
  it('no retired verb survives anywhere in the fixture text', () => {
    for (const path of SOURCES) {
      const text = read(path).replace(RETIRED_EXEMPT, '');
      for (const { verb, replacement } of RETIRED_VERBS) {
        const hit = new RegExp(`\\b${verb}`, 'i').exec(text);
        expect(
          hit,
          `${path} still says "${hit?.[0] ?? verb}"; the CLI retired \`tenjin ${verb}\` in favor of \`tenjin ${replacement}\``,
        ).toBeNull();
      }
    }
  });
});

// The candidate field list in the tenjin-search skill, checked against the wire
// schema it describes. This is the third time in two weeks that skill text has
// drifted from the wire, and it is the worst place for it: the list is what an
// agent uses to decide whether it already has enough to buy on, so a stale entry
// sends it looking for a field the server stopped sending. Cheap to keep honest,
// so keep it honest per-commit rather than per-review.
const CANDIDATE_BULLET = /A candidate is a lean hit:([\s\S]*?`)\./;

describe('skill text follows the wire schema', () => {
  it('the tenjin-search candidate bullet names exactly the candidate schema keys', () => {
    const skill = readFileSync(`${SKILLS_DIR}tenjin-search/SKILL.md`, 'utf8');
    const bullet = CANDIDATE_BULLET.exec(skill);
    expect(
      bullet?.[1],
      'tenjin-search/SKILL.md has no "A candidate is a lean hit:" list',
    ).toBeDefined();

    // The doc names the nested handle as `creator.handle`, which is the useful
    // thing to tell a reader; the schema key is `creator`. Compare on the key,
    // so the dotted form stays legal but an invented top-level field does not.
    const named = [...(bullet?.[1] ?? '').matchAll(/`([^`]+)`/g)].map(
      (m) => (m[1] ?? '').split('.')[0] ?? '',
    );

    expect(named.length, 'the bullet lists no fields').toBeGreaterThan(0);
    expect(new Set(named).size, `the bullet repeats a field: ${named.join(', ')}`).toBe(
      named.length,
    );
    expect([...named].sort()).toEqual(Object.keys(searchCandidateSchema.shape).sort());
  });
});
