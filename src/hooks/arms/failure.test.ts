import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookInput } from '../../adapters/types';
import { nativeSessionOf } from '../../lib/session';
import { PRODUCTION_ORIGIN } from '../../lib/production-origin';
import { runFire } from '../fire';
import { TEAM_OPENER } from '../prose';
import type { LoopDb } from '../store';
import type { Actor, Deps, KernelConfig, Plan } from '../types';
import { failureArm } from './failure';
import {
  LEAD,
  NOW,
  cleanup,
  fireContext,
  freshDb,
  hookInput,
  kernelConfig,
  toolInput,
} from './test-support';

/**
 * The failure arm on the kernel. Under test: the plan's shape by config (both
 * rounds against a team origin and nothing at all without one), what each round
 * actually puts on the wire, and the once-per-question gate over a re-run.
 */

const TEAM = kernelConfig();
const PUBLIC_ONLY: KernelConfig = { ...TEAM, baseUrl: PRODUCTION_ORIGIN };
const SEARCH_ID = '11111111-1111-4111-8111-111111111111';
const POST_ID = '22222222-2222-4222-8222-222222222222';

const ENOENT =
  "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'\n    at run (src/migrate.ts:12:3)\n";
const ENOENT_LINE = "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'";
const DATE_TEST = 'src/date.test.ts > formatDate > handles null';
const VITEST_FAIL = ` FAIL  ${DATE_TEST}\nAssertionError: expected undefined to be null\n`;
/** A real vitest 4.1.10 run's last five lines, `2>&1 | tail -5`: nothing but
 *  the tenjin reporter's lines survived the pipe. */
const TAIL5 = readFileSync(
  new URL('../failure/fixtures/vitest-tail5.txt', import.meta.url),
  'utf8',
);
const TAIL5_NAMES = [
  'test/helper.test.ts > helpers > fails inside a named helper',
  'test/session expiry.test.ts > expires after the window',
  'test/session.test.ts > session > renews session, restarting the maxAge window',
  'test/store.test.ts > store > loads a user',
];
/** One error line, printed off a frame the caller names: the same sentence in
 *  two files, with no test to tell them apart. */
const typeError = (file: string): string =>
  "TypeError: Cannot read properties of undefined (reading 'id')\n    at load (" +
  file +
  ':12:3)\n';
const LINE_ONLY = /^\["line:[0-9a-f]{32}"\]$/;

let db: LoopDb;

beforeEach(() => {
  db = freshDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

interface Shell {
  command: string;
  ok: boolean;
  stdout?: string;
  stderr?: string;
  actor?: Actor;
}

function shell(s: Shell): HookInput {
  const actor = s.actor ?? LEAD;
  return hookInput({
    event: 'tool.after',
    native: { event: 'PostToolUse' },
    // The input carries the NATIVE id; `actorOf` prefixes the harness back on.
    session: nativeSessionOf(actor.session),
    ...(actor.agent !== '' ? { agent: actor.agent } : {}),
    tool: {
      ...toolInput('shell', { command: s.command }),
      ok: s.ok,
      result: { stdout: s.stdout ?? '', stderr: s.stderr ?? '' },
    },
  });
}

function deps(config: KernelConfig = TEAM, clock: () => number = () => NOW): Deps {
  return {
    db,
    config: () => config,
    clock,
    log: () => undefined,
    arms: [failureArm],
    adapters: {},
  };
}

function candidate(): Record<string, unknown> {
  return {
    resourceId: POST_ID,
    url: `${TEAM.baseUrl}/p/enoent`,
    slug: 'enoent',
    title: 'drizzle.config.ts is read from the cwd',
    artifactType: 'finding',
    price: '0',
    asOf: null,
    validUntil: null,
    matchReasons: ['key'],
    estimatedTokens: 120,
    creator: { handle: 'ali' },
    body: { text: 'Run the migration from the package root, not the repo root.' },
  };
}

interface ShelfCall {
  path: string;
  body: { keys?: Array<{ kind: string; key: string }>; query?: string };
}

/** A stubbed shelf that records every request's path and body and answers
 *  `hits` items on each call in turn (the last entry repeats). BOTH ROUNDS
 *  come through here: `/api/keys/resolve` in stage 0 and `/api/search` in
 *  stage 1, so a test can say which round asked what. */
function shelf(hits: Array<Array<Record<string, unknown>>>): { calls: ShelfCall[] } {
  const calls: ShelfCall[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    calls.push({
      path: new URL(String(input)).pathname,
      body: (await new Request(String(input), init).json()) as ShelfCall['body'],
    });
    const items = hits[Math.min(calls.length, hits.length) - 1] ?? [];
    return new Response(
      JSON.stringify({
        schemaVersion: 3,
        searchId: SEARCH_ID,
        calibration: 'key-v1',
        items,
        matched: items.length,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return { calls };
}

async function fire(input: HookInput, d: Deps = deps()) {
  const result = await runFire(input, d);
  result.commit();
  const row = db
    .prepare('SELECT reason, question_key FROM fires ORDER BY rowid DESC LIMIT 1')
    .get() as {
    reason: string;
    question_key: string | null;
  };
  const legs = db
    .prepare(
      'SELECT stage, shelf, outcome FROM legs WHERE fire_id = (SELECT id FROM fires ORDER BY rowid DESC LIMIT 1) ORDER BY stage, shelf',
    )
    .all() as Array<{ stage: number; shelf: string; outcome: string }>;
  return { emit: result.emit, row, legs };
}

function keysOf(call: ShelfCall): string[] {
  return (call.body.keys ?? []).map((k) => k.key);
}

async function planOf(input: HookInput, config: KernelConfig = TEAM): Promise<Plan | null> {
  const ctx = fireContext({ db, arm: failureArm, input, config });
  const planned = await failureArm.plan?.(ctx);
  return planned !== null && planned !== undefined && 'stages' in planned ? planned : null;
}

const shelvesOf = (plan: Plan | null) => plan?.stages.map((s) => s.map((l) => l.shelf));

describe('the failure arm registration', () => {
  it('is one tool-wait arm on the shell result', () => {
    expect(failureArm.id).toBe('failure');
    expect(failureArm.wait).toBe('tool');
    expect(failureArm.on).toEqual([{ event: 'tool.after', kind: 'shell' }]);
  });
});

describe('the plan', () => {
  it('asks nothing when push is off, behind a head that is not a toolchain, or on a pass', async () => {
    const off = kernelConfig({ failure: false });
    expect(
      await planOf(shell({ command: 'pnpm db:migrate', ok: false, stderr: ENOENT }), off),
    ).toBeNull();
    expect(
      await planOf(shell({ command: 'git show x | grep ENOENT', ok: false, stderr: ENOENT })),
    ).toBeNull();
    expect(await planOf(shell({ command: 'pnpm db:migrate', ok: true, stdout: 'ok' }))).toBeNull();
  });

  it('asks nothing from totals alone: no test named and no line to say', async () => {
    const totals = ' Test Files  1 failed (1)\n      Tests  2 failed (2)\n';
    expect(await planOf(shell({ command: 'pnpm build', ok: false, stdout: totals }))).toBeNull();
  });

  it('asks nothing at all without a team origin: both rounds go to a team shelf alone', async () => {
    const plan = await planOf(
      shell({ command: 'pnpm db:migrate', ok: false, stderr: ENOENT }),
      PUBLIC_ONLY,
    );
    expect(plan).toBeNull();
  });

  it('asks the error line in words when the output names no test, keyed on its own text', async () => {
    const plan = await planOf(shell({ command: 'pnpm db:migrate', ok: false, stderr: ENOENT }));
    expect(shelvesOf(plan)).toEqual([['team']]);
    expect(plan?.question.text).toBe(ENOENT_LINE);
    expect(plan?.question.questionKey).toMatch(LINE_ONLY);
  });

  it('reads a coloured diagnostic as the same failure as an uncoloured one', async () => {
    // A pty or `FORCE_COLOR` puts an SGR sequence in front of the line, and
    // every marker that recognizes one is anchored to the start of the line.
    const red = '[31m';
    const off = '[39m';
    const coloured =
      red +
      'Error:' +
      off +
      " ENOENT: no such file or directory, open 'drizzle.config.ts'\n" +
      '[2m    at run (src/migrate.ts:12:3)[22m\n';
    const plain = await planOf(shell({ command: 'pnpm db:migrate', ok: false, stderr: ENOENT }));
    const plan = await planOf(shell({ command: 'pnpm db:migrate', ok: false, stderr: coloured }));
    // The line reaches the wire as the person saw it — no `[31m` residue, which
    // `mask` would not have taken off (it deletes the escape byte alone).
    expect(plan?.question.text).toBe(ENOENT_LINE);
    // And it is the SAME failure: colour must not fork the question.
    expect(plan?.question.questionKey).toBe(plain?.question.questionKey);
  });

  it('reads a coloured diagnostic whose only marker is start-anchored', async () => {
    // `npm ERR!`, `panic:`, `fatal:` and `error[E\d+]` are anchored and have no
    // unanchored twin, so a colour in front of them left the arm with nothing
    // to ask at all rather than with a worse question.
    const coloured = '[31mnpm ERR![39m code ELIFECYCLE\n[31mnpm ERR![39m errno 1\n';
    const plan = await planOf(shell({ command: 'pnpm build', ok: false, stderr: coloured }));
    expect(plan?.question.text).toBe('npm ERR! errno 1');
  });

  it('reads through an OSC-8 hyperlink sitting in front of the marker', async () => {
    // OSC, not CSI: `ESC ] 8 ; ; <url> BEL <text> ESC ] 8 ; ; BEL`, which is how
    // a runner turns a path into a clickable link.
    const link = (url: string, text: string): string => ']8;;' + url + '' + text + ']8;;';
    const stderr = link('https://pnpm.io/errors/ELIFECYCLE', 'npm ERR!') + ' errno 1\n';
    const plan = await planOf(shell({ command: 'pnpm build', ok: false, stderr }));
    expect(plan?.question.text).toBe('npm ERR! errno 1');
  });

  it('gives two different failures two different question keys', async () => {
    const one = await planOf(shell({ command: 'pnpm lint', ok: false, stderr: 'error: rule a\n' }));
    const two = await planOf(shell({ command: 'pnpm lint', ok: false, stderr: 'error: rule b\n' }));
    expect(one?.question.questionKey).not.toBe(two?.question.questionKey);
    expect(one?.question.questionKey.length).toBeGreaterThan(0);
  });

  it('asks the failing test by name, then its line in words with the name beside it', async () => {
    const { calls } = shelf([[]]);
    const { row, legs } = await fire(
      shell({ command: 'pnpm test', ok: false, stdout: VITEST_FAIL }),
    );
    expect(row.reason).toBe('no-hit');
    expect(calls.map((c) => c.path)).toEqual(['/api/keys/resolve', '/api/search']);
    expect(calls[0]!.body.keys).toEqual([{ kind: 'fingerprint', key: 'test:' + DATE_TEST }]);
    expect(calls[1]!.body.query).toBe(
      'AssertionError: expected undefined to be null — ' + DATE_TEST,
    );
    // The test key, then the hash of the words, as one readable array.
    const parts = JSON.parse(row.question_key ?? '[]') as string[];
    expect(parts[0]).toBe('test:' + DATE_TEST);
    expect(parts[1]).toMatch(/^line:[0-9a-f]{32}$/);
    expect(legs.map((l) => [l.stage, l.shelf, l.outcome])).toEqual([
      [0, 'keys', 'miss'],
      [1, 'team', 'miss'],
    ]);
  });

  it('never reaches the words when a key answered', async () => {
    const { calls } = shelf([[candidate()]]);
    const { row, emit } = await fire(
      shell({ command: 'pnpm test', ok: false, stdout: VITEST_FAIL }),
    );
    expect(row.reason).toBe('hit');
    expect(calls.map((c) => c.path)).toEqual(['/api/keys/resolve']);
    // A key match is a team surface, so it is delivered under the team opener.
    expect(emit?.context).toContain(TEAM_OPENER);
  });

  it('asks every test a tail-cut run names, off the reporter lines printed last', async () => {
    // THE CASE THE REPORTER LINES EXIST FOR. The agent's pipe kept five lines
    // and no assertion; the names and lines are all there is, and all it needs.
    const { calls } = shelf([[]]);
    await fire(shell({ command: 'pnpm vitest run 2>&1 | tail -5', ok: false, stdout: TAIL5 }));
    expect(keysOf(calls[0]!)).toEqual(TAIL5_NAMES.map((n) => 'test:' + n));
    // The last named failure's line, not the unhandled error printed after it.
    expect(calls[1]!.body.query).toBe(
      "TypeError: Cannot read properties of undefined (reading 'id') — test/store.test.ts > store > loads a user",
    );
  });

  it('sends at most ten keys, the last ten, in one resolve', async () => {
    const lines = Array.from(
      { length: 12 },
      (_, i) =>
        `::error title=src/t${i + 1}.test.ts > s > case ${i + 1}::AssertionError: expected ${i + 1} to be 0`,
    );
    const plan = await planOf(
      shell({ command: 'pnpm test', ok: false, stdout: lines.join('\n') + '\n' }),
    );
    const parts = JSON.parse(plan?.question.questionKey ?? '[]') as string[];
    const keys = parts.filter((p) => p.startsWith('test:'));
    expect(keys).toHaveLength(10);
    expect(keys[0]).toBe('test:src/t3.test.ts > s > case 3');
    expect(keys[9]).toBe('test:src/t12.test.ts > s > case 12');
  });

  it('asks an error no test owns in words, and keys nothing on it', async () => {
    const stdout = "::error title=test/broken.test.ts::Error: Cannot find module './x'\n";
    const plan = await planOf(shell({ command: 'pnpm test', ok: false, stdout }));
    expect(shelvesOf(plan)).toEqual([['team']]);
    expect(plan?.question.text).toBe("Error: Cannot find module './x'");
  });
});

describe('what a failure asks with', () => {
  it('is one question when one error line comes off two frames: nothing else tells them apart', async () => {
    // With no test named, the words are the whole question, and asking the same
    // words twice would ask the shelf nothing new.
    const { calls } = shelf([[]]);
    const one = await fire(
      shell({ command: 'pnpm test', ok: false, stderr: typeError('src/a.ts') }),
    );
    const two = await fire(
      shell({ command: 'pnpm test', ok: false, stderr: typeError('src/b.ts') }),
    );
    expect(one.row.reason).toBe('no-hit');
    expect(two.row.reason).toBe('cached');
    expect(calls.map((c) => c.path)).toEqual(['/api/search']);
  });

  it('is two questions when the same assertion fails in two tests', async () => {
    // THE COLLISION THE COMPOSED KEY EXISTS FOR. The same assertion in two tests
    // prints the same sentence, and a key over the sentence alone would hand the
    // second test the first's cached miss — its own name sitting right there,
    // never resolved. So the call count is the assertion, not just the keys.
    const failing = (name: string): string =>
      ` FAIL  src/a.test.ts > suite > ${name}\nAssertionError: expected 1 to be 2\n`;
    const { calls } = shelf([[]]);
    const one = await fire(shell({ command: 'pnpm test', ok: false, stdout: failing('one') }));
    const two = await fire(shell({ command: 'pnpm test', ok: false, stdout: failing('two') }));
    expect(one.row.question_key).not.toBe(two.row.question_key);
    expect(calls.map((c) => c.path)).toEqual([
      '/api/keys/resolve',
      '/api/search',
      '/api/keys/resolve',
      '/api/search',
    ]);
  });

  it('is one problem however many times the same actor re-runs it', async () => {
    shelf([[]]);
    const input = shell({ command: 'pnpm db:migrate', ok: false, stderr: ENOENT });
    await fire(input);
    const { row } = await fire(input);
    expect(row.reason).toBe('cached');
  });
});
