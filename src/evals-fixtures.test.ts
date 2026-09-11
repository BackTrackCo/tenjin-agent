import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildProgram } from './cli';
import { searchCandidateSchema } from './lib/agent-api';
import { PACKAGED_SKILL_NAMES, SHIPPED_SKILL_FILES } from './lib/skills-source';
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

const FIXTURE_PATHS = walkFixtures();

/**
 * Every markdown file the CLI skills ship to npm (package.json `files`), so a
 * stale verb in one reaches every installed agent. DERIVED, for the same reason
 * the fixtures below are: a hand-written list guards the files someone remembered,
 * and this one named two while the package shipped four. Both reference files were
 * outside it, and `references/maintain.md` is where `tenjin edit`'s whole flag
 * vocabulary now lives, so a flag rename could rot there with CI green.
 *
 * The vendored `skills/tenjin/` mirror is deliberately excluded: it is generated
 * from the tenjin repo and skill-drift CI owns whether it matches its source.
 */
const SHIPPED_SKILLS: readonly string[] = PACKAGED_SKILL_NAMES.filter(
  (n) => n !== 'tenjin',
).flatMap((name) => SHIPPED_SKILL_FILES[name].map((rel) => `${name}/${rel}`));

/**
 * Everything the two verb guards sweep, read once, each carrying the label a
 * failure names it by. The fixtures and the shipped skills live under different
 * roots, so the text travels with the entry rather than the path.
 */
const SOURCES: ReadonlyArray<{ label: string; text: string }> = [
  ...FIXTURE_PATHS.map((path) => ({ label: `evals/${path}`, text: read(path) })),
  ...SHIPPED_SKILLS.map((path) => ({
    label: `skills/${path}`,
    text: readFileSync(`${SKILLS_DIR}${path}`, 'utf8'),
  })),
];

// Derived from the walk rather than listed, so a skill's fixtures are guarded
// the day they land instead of the day someone remembers to add them here.
const OUTPUT_FILES = FIXTURE_PATHS.filter((path) => path.endsWith('/evals.json'));
const TRIGGER_FILES = FIXTURE_PATHS.filter((path) => path.endsWith('/trigger-eval.json'));

// The deferral probe is a different instrument from the balanced set above, so
// the balance rule does not apply to it: every query states that no CLI is
// available, and a pass is the skill standing down rather than firing. What has
// to hold instead is that it stays all-negative and keeps a balanced set beside
// it, because on its own a description that never fires at all would ace it.
const DEFER_FILES = FIXTURE_PATHS.filter((path) => path.endsWith('/trigger-eval-defer.json'));

// Verbs the CLI has retired, and what replaced them. The invocation check below
// only sees backtick-quoted commands, so on its own it reddens the build for
// `tenjin lookup` while leaving "the lookup command includes --json" standing.
// This sweeps the prose too, which is the half a rename actually forgets.
//
// The sweep matches on the word-boundary PREFIX (`\blookup`) and has to stay
// that shape: the shipped skill prose says "look up" as plain English in
// several places, and a looser pattern would redden the build on a sentence
// that is not naming a command at all.
const RETIRED_VERBS: ReadonlyArray<{ verb: string; replacement: string }> = [
  { verb: 'lookup', replacement: 'search' },
];

// `scripts/eval-lookup-recall.ts` is a script in the tenjin repo, not a CLI verb,
// and it kept its name through the search rename.
const RETIRED_EXEMPT = /eval-lookup-recall/g;

interface Registry {
  /** Top-level verbs: `search`, `publish`, `wallet`. */
  verbs: Set<string>;
  /** Two-word forms: `wallet show`, `config set`. */
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

// Only backtick-quoted invocations: `tenjin search`, `tenjin wallet show`. The
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

  it.each(TRIGGER_FILES)('%s is balanced and free of duplicate queries', (path) => {
    const cases = JSON.parse(read(path)) as TriggerCase[];
    const positives = cases.filter((c) => c.should_trigger);

    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(positives.length).toBe(cases.length - positives.length);
    expect(new Set(cases.map((c) => c.query)).size).toBe(cases.length);
    for (const c of cases) expect(c.rationale.length, c.query).toBeGreaterThan(0);
  });

  it('the deferral probe is all-negative and sits beside a balanced trigger set', () => {
    // Named rather than merely walked: the probe guards a gate the balanced set
    // cannot reach (this skill standing down when the CLI it needs is absent),
    // so deleting the file has to redden the build rather than pass vacuously.
    expect(DEFER_FILES).toContain('tenjin-search/trigger-eval-defer.json');

    for (const path of DEFER_FILES) {
      const cases = JSON.parse(read(path)) as TriggerCase[];
      expect(cases.length, `${path} is empty`).toBeGreaterThan(0);
      expect(
        cases.filter((c) => c.should_trigger).map((c) => c.query),
        `${path} holds a positive; a deferral probe grades only standing down`,
      ).toEqual([]);
      expect(new Set(cases.map((c) => c.query)).size).toBe(cases.length);
      for (const c of cases) expect(c.rationale.length, c.query).toBeGreaterThan(0);

      const balanced = path.replace('trigger-eval-defer.json', 'trigger-eval.json');
      expect(
        TRIGGER_FILES,
        `${path} has no ${balanced} beside it, so nothing measures the firing half`,
      ).toContain(balanced);
    }
  });

  // The injection fixtures are payloads that an agent under test is meant to
  // sometimes obey: the run where such a case earns its keep is the run where an
  // agent collects local state and sends it somewhere. So the destination they
  // name has to be one that cannot receive anything, and that is a property to
  // enforce rather than to keep remembering. The runner substitutes the
  // placeholder with a loopback sentinel at seed time (harness/sentinel.py).
  it('no seeded fixture body names an off-machine destination', () => {
    const runner = readFileSync(
      fileURLToPath(new URL('../evals/harness/run_output_eval.py', import.meta.url)),
      'utf8',
    );
    const placeholder = /^SENTINEL_PLACEHOLDER = "([^"]+)"$/m.exec(runner)?.[1];
    expect(placeholder, 'run_output_eval.py declares no SENTINEL_PLACEHOLDER').toBeDefined();

    // Everything a case seeds, plus everything sitting in a fixtures directory
    // waiting to be seeded, since the second becomes the first without a code
    // change.
    const seeded = new Set([
      ...OUTPUT_FILES.flatMap((path) =>
        (JSON.parse(read(path)) as EvalFile).evals.flatMap((c) => c.files),
      ),
      ...FIXTURE_PATHS.filter((path) => path.includes('/fixtures/')),
    ]);
    expect(seeded.size).toBeGreaterThan(0);

    let usesPlaceholder = 0;
    for (const path of seeded) {
      const body = read(path);
      expect(
        body.match(/\bhttps?:\/\/[^\s)"'`]+/gi) ?? [],
        `${path} names an absolute URL; a seeded payload must point at ${placeholder}, which the runner replaces with a loopback sentinel`,
      ).toEqual([]);
      if (body.includes(placeholder as string)) usesPlaceholder += 1;
    }

    // A rename on the Python side would otherwise leave the literal placeholder
    // in the agent's workspace: harmless, but the case would stop measuring.
    expect(
      usesPlaceholder,
      `no fixture uses ${placeholder}, so either the payload lost its destination or the constant was renamed on one side only`,
    ).toBeGreaterThan(0);
  });

  // The drift guard. A fixture may only name a command the CLI actually has.
  it('every tenjin command named in a fixture or a shipped skill is registered', () => {
    const reg = registry();

    for (const { label, text } of SOURCES) {
      for (const invocation of quotedInvocations(text)) {
        const verb = invocation.split(' ')[0] ?? invocation;
        // A verb that owns subcommands proves nothing on its own: `wallet`
        // is registered whether or not `wallet frobnicate` is, so a two-word
        // form has to match as a pair rather than falling back to the first
        // word. The bare group name is still a legitimate thing for prose to
        // name, so it passes on its own.
        const known = reg.parents.has(verb)
          ? invocation === verb || reg.pairs.has(invocation)
          : reg.verbs.has(verb);
        expect(
          known,
          `${label} names \`tenjin ${invocation}\`, which the CLI does not register`,
        ).toBe(true);
      }
    }
  });

  // The prose half of the same guard: a retired verb has to be gone from the
  // sentences and the fenced blocks too, not just from the quoted invocations.
  it('no retired verb survives anywhere in the fixture text', () => {
    for (const { label, text } of SOURCES) {
      const swept = text.replace(RETIRED_EXEMPT, '');
      for (const { verb, replacement } of RETIRED_VERBS) {
        const hit = new RegExp(`\\b${verb}`, 'i').exec(swept);
        expect(
          hit,
          `${label} still says "${hit?.[0] ?? verb}"; the CLI retired \`tenjin ${verb}\` in favor of \`tenjin ${replacement}\``,
        ).toBeNull();
      }
    }
  });
});

// The item field list in the tenjin-search skill, checked against the wire
// schema it describes. This is the third time in two weeks that skill text has
// drifted from the wire, and it is the worst place for it: the list is what an
// agent uses to decide whether it already has enough to buy on, so a stale entry
// sends it looking for a field the server stopped sending. Cheap to keep honest,
// so keep it honest per-commit rather than per-review.
//
// "item" since search v3, which renamed the array from `candidates` to `items`.
const ITEM_BULLET = /An item is a lean hit:([\s\S]*?`)\./;

describe('skill text follows the wire schema', () => {
  it('the tenjin-search item bullet names exactly the candidate schema keys', () => {
    const skill = readFileSync(`${SKILLS_DIR}tenjin-search/SKILL.md`, 'utf8');
    const bullet = ITEM_BULLET.exec(skill);
    expect(
      bullet?.[1],
      'tenjin-search/SKILL.md has no "An item is a lean hit:" list',
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

    // Compared as the symmetric difference rather than as two arrays, so a
    // failure names the field that moved instead of printing two eleven-item
    // lists for the reader to eyeball.
    const declared = Object.keys(searchCandidateSchema.shape);
    expect(
      {
        omittedByTheDoc: declared.filter((key) => !named.includes(key)),
        notInTheSchema: named.filter((key) => !declared.includes(key)),
      },
      'skills/tenjin-search/SKILL.md and searchCandidateSchema disagree; update whichever is stale',
    ).toEqual({ omittedByTheDoc: [], notInTheSchema: [] });
  });
});
