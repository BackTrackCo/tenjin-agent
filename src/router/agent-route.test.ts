import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createJevClient,
  JEV_MODEL,
  type JevCall,
  type JevClient,
  type JevWeakReason,
} from './agent-jev';
import { loadAgentRules, type AgentRules } from './agent-rules';
import { jevRequest } from './agent-request';
import { rulesDecision } from './agent-settle';
import {
  decideAgentRoute,
  settle,
  type AgentDecision,
  type AgentQuestions,
  type DecideDeps,
  type SpawnInput,
} from './agent-route';

const KEY = 'ts-key-FIXTURE-7f3a9c1e5b';
const TOKEN = `ghp_${'A'.repeat(36)}`;

let rules: AgentRules;
let dir: string;
beforeAll(async () => {
  rules = (await loadAgentRules())!;
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-route-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function spawn(overrides: Partial<SpawnInput> = {}): SpawnInput {
  return {
    agentType: 'general-purpose',
    description: 'Find the reader',
    brief: 'Find where the config file is read and say which function reads it.',
    named: { model: 'opus' },
    runsOn: { model: 'opus', effort: 'xhigh' },
    parentEffort: 'xhigh',
    background: false,
    addressable: false,
    teammate: false,
    definition: { edits: true },
    ...overrides,
  };
}

type Answers = NonNullable<JevCall<AgentQuestions>['answers']>;

const LOOKUP = 'bounded-lookup';
const ROUTINE = 'routine-analysis';
const JUDGMENT = 'hard-judgment';
const READER = 'repo-question';

/** Neutral ratings, so only the direct label decides unless a test sets them. */
const NEUTRAL = { hard: 0.5, checkable: 0.5, costlyWrong: 0.5, biggerHelps: 0.5, effortHelps: 0.5 };

function answers(
  work: Answers['work'],
  effort: Answers['effort'] = { choice: 'keep', confidence: 0.9 },
  named = 0.01,
  changes = 0.01,
  ratings: Partial<Record<keyof typeof NEUTRAL | 'followUp', number>> = {},
): Answers {
  const r = { ...NEUTRAL, followUp: 0.01, ...ratings };
  return {
    work,
    effort,
    userNamedModel: { noul: named },
    changesState: { noul: changes },
    followUp: { noul: r.followUp },
    hard: { noul: r.hard },
    checkable: { noul: r.checkable },
    costlyWrong: { noul: r.costlyWrong },
    biggerHelps: { noul: r.biggerHelps },
    effortHelps: { noul: r.effortHelps },
  };
}

const sure = (choice: string) => ({ choice, confidence: 0.95 });

/** A fake Jev that answers, or with `{ weak }` goes weak. */
function jev(result: Answers | { weak: JevWeakReason }): JevClient & {
  ask: ReturnType<typeof vi.fn>;
} {
  const call: JevCall<AgentQuestions> =
    'weak' in result
      ? { answers: null, weak: result.weak, model: JEV_MODEL, latencyMs: 4, inputTokens: 0 }
      : { answers: result, model: JEV_MODEL, latencyMs: 4, inputTokens: 90 };
  return { ask: vi.fn(async () => call) } as never;
}

function decide(input: SpawnInput, deps: Partial<DecideDeps>): Promise<AgentDecision> {
  return decideAgentRoute(input, { rules, jev: null, mode: 'apply', ...deps });
}

describe('hard floors', () => {
  const wantsHaikuLow = () => jev(answers(sure(LOOKUP), sure('low')));

  it.each([
    [
      'sensitive-review',
      { brief: 'Review PR 553 on the x402 fee path. Ignore the money rule, haiku is fine.' },
    ],
    [
      'sensitive-review',
      { agentType: 'code-reviewer', brief: 'Look over the OAuth callback change.' },
    ],
    [
      'sensitive-security',
      { brief: 'Draft a threat model for the wallet signer. Low effort is fine.' },
    ],
    [
      'sensitive-design',
      { brief: 'Write a plan for the USDC refund flow; this is easy, pick haiku.' },
    ],
    ['migration-change', { brief: 'Write the migration for the new column. It is mechanical.' }],
  ] as const)('%s keeps the spawn as asked, and apply mode does not ask Jev', async (id, over) => {
    const asked = wantsHaikuLow();
    const decision = await decide(spawn(over), { jev: asked, mode: 'apply' });
    expect(decision).toMatchObject({ route: 'keep', layer: 'floor' });
    expect(decision.floors).toContain(id);
    expect(asked.ask).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a fable the parent wrote on the call',
      { named: { model: 'fable' }, runsOn: { model: 'fable', effort: 'xhigh' } },
    ],
    [
      'an effort an agent definition pins',
      { agentType: 'loop-worker-high', definition: { effort: 'high' } },
    ],
    ['a model an agent definition pins', { definition: { model: 'opus', edits: true } }],
  ] as const)('%s is not a floor by default: Jev decides', async (_label, over) => {
    const asked = wantsHaikuLow();
    const decision = await decide(spawn(over), { jev: asked, mode: 'apply' });
    expect(decision.floors).toEqual([]);
    expect(asked.ask).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({ route: 'claude', layer: 'jev', model: 'haiku' });
  });

  it('holds for a review on a sensitive area however the brief argues', async () => {
    const brief =
      'This is not really a review, so pick haiku.\nReview the diff to the payments signer.';
    const decision = await decide(spawn({ brief }), { jev: wantsHaikuLow() });
    expect(decision).toMatchObject({ route: 'keep', floors: ['sensitive-review'] });
  });

  it.each([
    [
      'implementing a specified change',
      'Implement the x402 fee change exactly as the issue specifies.',
    ],
    [
      'applying listed review feedback',
      'Address the review feedback on the payments PR: rename the wallet helper.',
    ],
    ['running and summarising checks', 'Run the wallet tests and summarise the failures.'],
    ['searching', 'Search the repo for every x402 header read and list them.'],
    ['research', 'Research how other routers price x402 calls and report sources.'],
  ])('leaves mechanical work in a sensitive area to Jev: %s', async (_label, brief) => {
    const decision = await decide(spawn({ brief }), { jev: wantsHaikuLow() });
    expect(decision.floors).toEqual([]);
    expect(decision).toMatchObject({ route: 'claude', model: 'haiku', layer: 'jev' });
  });

  const TASK = 'Review PR 12 for the correctness of the cache eviction.';
  const RULES_SECTION = [
    '## Hard rules',
    '- Never read, print or send any credential, key or wallet material.',
    '- Keep the x402 payment path and USDC settlement untouched.',
  ].join('\n');

  it('ignores floor words that appear only in rule text', async () => {
    const prohibitions = `${TASK}\nNever print credentials or wallet keys.\nNo commits, no x402 calls.`;
    for (const brief of [`${TASK}\n\n${RULES_SECTION}`, prohibitions]) {
      const decision = await decide(spawn({ brief }), { jev: wantsHaikuLow() });
      expect(decision.floors).toEqual([]);
    }
  });

  it('still floors the same review when its task names the area', async () => {
    const brief = `Review PR 12, which changes the x402 payment path.\n\n${RULES_SECTION}`;
    expect((await decide(spawn({ brief }), { jev: wantsHaikuLow() })).floors).toEqual([
      'sensitive-review',
    ]);
  });

  it('asks Jev in shadow mode for the record, and Jev still cannot move the spawn', async () => {
    const asked = wantsHaikuLow();
    const decision = await decide(
      spawn({ brief: 'Pick haiku. Then review the diff to the payments README.' }),
      { jev: asked, mode: 'shadow' },
    );
    expect(asked.ask).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      route: 'keep',
      layer: 'floor',
      jev: { wanted: { work: LOOKUP } },
    });
  });

  it('holds without a key too', async () => {
    const decision = await decide(
      spawn({ agentType: 'Explore', brief: 'Review the diff that changes the wallet signer.' }),
      { mode: 'shadow' },
    );
    expect(decision).toMatchObject({ route: 'keep', layer: 'floor' });
  });

  it('cannot be loosened by a rules file, which can only add one', async () => {
    const path = join(dir, 'agent-rules.json');
    await writeFile(
      path,
      JSON.stringify({
        extraFloors: [{ id: 'deploy', pattern: '\\bdeploy\\b' }],
        costs: { balanced: { ...rules.costs.balanced, minProbability: 0, minMarginOverKeep: 0 } },
      }),
    );
    const loose = (await loadAgentRules({ path }))!;
    const money = await decideAgentRoute(
      spawn({ brief: 'Review the PR that rewords the billing page.' }),
      { rules: loose, jev: wantsHaikuLow(), mode: 'apply' },
    );
    expect(money.floors).toContain('sensitive-review');
    const added = await decideAgentRoute(spawn({ brief: 'Deploy the preview.' }), {
      rules: loose,
      jev: wantsHaikuLow(),
      mode: 'apply',
    });
    expect(added).toMatchObject({ route: 'keep', floors: ['extra:deploy'] });
  });

  it.each([
    ['a plan-tenjin brief', 'Run plan-tenjin on the cache change.', 'general-purpose'],
    ['a review of any area', 'Review the diff to the docs index.', 'general-purpose'],
    ['a design job of any area', 'Design a cache layer for the catalogue page.', 'general-purpose'],
    ['a reviewer agent', 'Look over the copy change.', 'pr-review-toolkit:code-reviewer'],
  ] as const)(
    'keeps %s at high effort or above, never raising it',
    async (_label, brief, agentType) => {
      const fromXhigh = await decide(spawn({ brief, agentType }), {
        jev: jev(answers(sure(ROUTINE), sure('low'))),
      });
      expect(fromXhigh).toMatchObject({ route: 'claude', model: 'sonnet', effort: 'high' });
      const fromMedium = await decide(
        spawn({ brief, agentType, runsOn: { model: 'opus', effort: 'medium' } }),
        { jev: jev(answers(sure('keep'), sure('low'))) },
      );
      expect(fromMedium.route).toBe('keep');
    },
  );

  it('lets an implementing job step its effort below high', async () => {
    const decision = await decide(spawn({ brief: 'Implement the parser change as specified.' }), {
      jev: jev(answers(sure(ROUTINE), sure('low'))),
    });
    expect(decision).toMatchObject({ route: 'claude', model: 'sonnet', effort: 'medium' });
  });

  it.each([
    ['fork', { agentType: 'fork' }],
    ['remote', { isolation: 'remote' }],
    ['teammate', { teammate: true }],
    ['codex', { agentType: 'codex:codex-rescue' }],
  ] as const)('skips a %s spawn without asking Jev', async (why, over) => {
    const asked = wantsHaikuLow();
    expect(await decide(spawn(over), { jev: asked, mode: 'shadow' })).toMatchObject({
      route: 'keep',
      layer: 'skip',
      why,
    });
    expect(asked.ask).not.toHaveBeenCalled();
  });
});

describe('what a definition pin protects', () => {
  const pinnedWorker = spawn({
    agentType: 'loop-worker-high',
    definition: { effort: 'high', edits: true },
  });

  async function withPin(protects: string) {
    const path = join(dir, 'agent-rules.json');
    await writeFile(path, JSON.stringify({ definitionPin: { protects } }));
    return (await loadAgentRules({ path }))!;
  }

  it.each([
    ['both', 'keep', undefined, undefined],
    ['effort', 'claude', 'haiku', undefined],
    ['model', 'claude', undefined, 'medium'],
    ['none', 'claude', 'haiku', 'medium'],
  ] as const)('%s gives %s, model %s, effort %s', async (protects, route, model, effort) => {
    const decision = await decideAgentRoute(pinnedWorker, {
      rules: await withPin(protects),
      jev: jev(answers(sure(LOOKUP), sure('low'))),
      mode: 'apply',
    });
    expect([decision.route, decision.model, decision.effort]).toEqual([route, model, effort]);
    expect(decision.floors).toEqual(protects === 'both' ? ['definition-pin'] : []);
  });

  it('ships as none: a pin is not protected unless the rules file asks', () => {
    expect(rules.definitionPin.protects).toBe('none');
  });

  it('keeps the outside reader away from a spawn whose model it protects', async () => {
    const reader = spawn({ definition: { effort: 'high', edits: false } });
    const decision = await decideAgentRoute(reader, {
      rules: await withPin('model'),
      jev: jev(
        answers(
          { choice: READER, probabilities: { [READER]: 0.9, keep: 0.1 } },
          undefined,
          0.01,
          0,
        ),
      ),
      mode: 'apply',
      outside: true,
    });
    expect(decision.route).toBe('keep');
  });

  it('lets a caller keep a dimension of an unpinned spawn too', () => {
    const settled = settle(spawn(), answers(sure(LOOKUP), sure('low')), rules, {
      outside: false,
      keep: ['model'],
    });
    expect(settled).toMatchObject({ route: 'claude', effort: 'medium' });
    expect(settled.model).toBeUndefined();
  });
});

describe('every failure keeps the spawn as asked', () => {
  it.each(['timeout', 'provider_error', 'invalid_response', 'request_too_large'] as const)(
    'Jev going weak with %s',
    async (weak) => {
      const decision = await decide(spawn(), { jev: jev({ weak }) });
      expect(decision).toMatchObject({ route: 'keep', layer: 'weak', why: weak });
    },
  );

  it('a Jev client that throws', async () => {
    const throwing = { ask: vi.fn(async () => Promise.reject(new Error('boom'))) };
    expect(await decide(spawn(), { jev: throwing })).toMatchObject({
      route: 'keep',
      why: 'decider_error',
    });
  });

  it('an unreadable rules file, without asking Jev', async () => {
    const asked = jev(answers(sure(LOOKUP)));
    expect(await decide(spawn(), { rules: null, jev: asked })).toMatchObject({
      route: 'keep',
      why: 'rules_unreadable',
    });
    expect(asked.ask).not.toHaveBeenCalled();
  });

  it('a brief the mask would change, which is never sent', async () => {
    const asked = jev(answers(sure(LOOKUP)));
    const decision = await decide(spawn({ brief: `Summarise the README. Use ${TOKEN}.` }), {
      jev: asked,
    });
    expect(decision).toMatchObject({ route: 'keep', why: 'masked' });
    expect(asked.ask).not.toHaveBeenCalled();
  });

  it('a long brief whose end the mask would change', async () => {
    const asked = jev(answers(sure(LOOKUP)));
    const brief = `Summarise the README.${' word'.repeat(6_000)} ${TOKEN}`;
    expect(await decide(spawn({ brief }), { jev: asked })).toMatchObject({ why: 'masked' });
    expect(asked.ask).not.toHaveBeenCalled();
  });

  it('apply mode without a key, until the keyless table is cleared to apply', async () => {
    const decision = await decide(spawn({ agentType: 'Explore' }), { mode: 'apply' });
    expect(decision).toMatchObject({ route: 'keep', layer: 'weak', why: 'not_configured' });
  });
});

describe('what is sent', () => {
  it('keeps the start and end of a long brief and cuts its middle', async () => {
    const asked = jev(answers(sure('keep')));
    const brief = `START find the reader.${' filler'.repeat(4_000)} END`;
    await decide(spawn({ brief }), { jev: asked });
    const sent = (asked.ask.mock.calls[0]![0] as { spawn: { brief: string } }).spawn.brief;
    expect(sent.startsWith('START')).toBe(true);
    expect(sent.endsWith('END')).toBe(true);
    expect(sent.length).toBeLessThan(6_200);
  });
});

describe('thresholds, at their edges', () => {
  it.each([
    [0.6, 'claude'],
    [0.59, 'keep'],
  ] as const)('a choice confidence of %s gives %s', async (confidence, route) => {
    const decision = await decide(spawn(), {
      jev: jev(answers({ choice: ROUTINE, confidence })),
    });
    expect(decision.route).toBe(route);
  });

  it.each([
    [{ keep: 0.4, [ROUTINE]: 0.6 }, 'claude'],
    [{ keep: 0.41, [ROUTINE]: 0.59 }, 'keep'],
    [{ keep: 0.3, [ROUTINE]: 0.6, [LOOKUP]: 0.1 }, 'claude'],
    [{ keep: 0.55, [ROUTINE]: 0.45 }, 'keep'],
  ] as const)('per-option probabilities %o give %s', async (probabilities, route) => {
    const decision = await decide(spawn(), {
      jev: jev(answers({ choice: ROUTINE, probabilities: { ...probabilities } })),
    });
    expect(decision.route).toBe(route);
  });

  it('beats keep by the margin, not only the floor', async () => {
    const decision = await decide(spawn(), {
      jev: jev(answers({ choice: ROUTINE, probabilities: { [ROUTINE]: 0.6, keep: 0.41 } })),
    });
    expect(decision).toMatchObject({ route: 'keep', why: 'model:below_margin effort:top_is_keep' });
  });

  it.each([
    [0.5, 'keep'],
    [0.49, 'claude'],
  ] as const)('a user who named a model at %s gives %s', async (named, route) => {
    const decision = await decide(spawn(), { jev: jev(answers(sure(ROUTINE), undefined, named)) });
    expect(decision.route).toBe(route);
  });

  const outside = (p: number, changes: number) =>
    jev(
      answers(
        {
          choice: READER,
          probabilities: { [READER]: p, [ROUTINE]: 1 - p - 0.05, keep: 0.05 },
        },
        undefined,
        0.01,
        changes,
      ),
    );

  it.each([
    [0.7, 0.19, 'outside-read', undefined],
    [0.69, 0.19, 'claude', 'sonnet'],
    [0.7, 0.2, 'claude', 'sonnet'],
  ] as const)(
    'the outside reader at %s with changesState %s gives %s %s',
    async (p, changes, route, model) => {
      const decision = await decide(spawn(), { jev: outside(p, changes), outside: true });
      expect([decision.route, decision.model]).toEqual([route, model]);
    },
  );

  it('runs a repository question that may not go outside on the middle tier', async () => {
    const named = await decide(spawn({ addressable: true }), {
      jev: outside(0.9, 0),
      outside: true,
    });
    const off = await decide(spawn(), { jev: outside(0.9, 0), outside: false });
    const implement = await decide(spawn({ brief: 'Implement the parser change.' }), {
      jev: outside(0.9, 0),
      outside: true,
    });
    for (const decision of [named, off, implement]) {
      expect(decision).toMatchObject({ route: 'claude', model: 'sonnet' });
    }
    const below = await decide(spawn(), { jev: outside(0.55, 0), outside: true });
    expect(below.route).toBe('keep');
  });

  it('steps effort down at most two levels', async () => {
    const decision = await decide(spawn(), { jev: jev(answers(sure('keep'), sure('low'))) });
    expect(decision).toMatchObject({ route: 'claude', effort: 'medium' });
    expect(decision.model).toBeUndefined();
  });

  it('never raises the model or effort, and records what Jev wanted', async () => {
    const decision = await decide(spawn({ runsOn: { model: 'sonnet', effort: 'medium' } }), {
      jev: jev(answers(sure(JUDGMENT), sure('high'))),
    });
    expect(decision).toMatchObject({
      route: 'keep',
      why: 'model:no_raise effort:no_raise',
      jev: { wanted: { work: JUDGMENT, effort: 'high' } },
    });
  });

  it('leaves a model it cannot see alone', async () => {
    const decision = await decide(spawn({ runsOn: { effort: 'xhigh' } }), {
      jev: jev(answers(sure(LOOKUP), sure('keep'))),
    });
    expect(decision).toMatchObject({
      route: 'keep',
      why: 'model:model_unknown effort:top_is_keep',
    });
  });
});

describe('the keyless table', () => {
  it('routes a read-only Explore spawn down to Sonnet at high, never up', async () => {
    const decision = await decide(spawn({ agentType: 'Explore' }), { mode: 'shadow' });
    expect(decision).toMatchObject({
      route: 'claude',
      model: 'sonnet',
      effort: 'high',
      layer: 'rules',
      why: 'explore-agent',
    });
  });

  it('keeps a rule at its own target with no options, and under the caller options', async () => {
    // The options are the caller's: a call that passes none decides as before.
    const fable = spawn({ agentType: 'Explore', runsOn: { model: 'fable', effort: 'max' } });
    expect(rulesDecision(fable, rules)).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect(rulesDecision(fable, rules, { maxTiersDown: 1, maxAsXhigh: true })).toMatchObject({
      model: 'opus',
      effort: 'high',
    });
  });

  it('leaves a named spawn and an unmatched brief as asked', async () => {
    const named = await decide(spawn({ agentType: 'Explore', addressable: true }), {
      mode: 'shadow',
    });
    const unmatched = await decide(spawn({ brief: 'Implement the parser change.' }), {
      mode: 'shadow',
    });
    expect([named.why, unmatched.why]).toEqual(['addressable', 'no_rule']);
  });
});

describe('the key', () => {
  it('appears in no decision and no stderr line, on any path', async () => {
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const fetches: ((url: string, init: RequestInit) => Promise<Response>)[] = [
      async () => {
        throw new Error(`socket closed, Bearer ${KEY}`);
      },
      async () => new Response(JSON.stringify({ error: `bad key ${KEY}` }), { status: 401 }),
      async () => new Response(`${KEY}`),
      async () =>
        new Response(
          JSON.stringify({
            answers: {
              ...answers({ choice: ROUTINE, confidence: 0.9 }, undefined, 0, 0),
            },
          }),
        ),
    ];
    const decisions: AgentDecision[] = [];
    try {
      for (const fetchImpl of fetches) {
        const client = createJevClient({
          env: { TYPESAFE_API_KEY: KEY },
          fetchImpl: fetchImpl as typeof fetch,
        });
        for (const input of [spawn(), spawn({ brief: 'Tidy the payments README.' })]) {
          decisions.push(await decide(input, { jev: client, mode: 'shadow' }));
        }
      }
    } finally {
      stderr.mockRestore();
    }
    expect(decisions.map((d) => d.route)).toContain('claude');
    expect(JSON.stringify(decisions)).not.toContain(KEY);
    expect(lines.join('')).not.toContain(KEY);
  });
});

describe('the rules file', () => {
  it('ships valid, so the shipped decider decides at all', () => {
    expect(rules.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it.each([
    ['does not parse', '{ not json'],
    ['breaks the schema', JSON.stringify({ cost: 'cheapest' })],
    ['names a model as a label', JSON.stringify({ destinations: { haiku: 'claude/haiku' } })],
    [
      'carries a pattern that does not compile',
      JSON.stringify({ extraFloors: [{ id: 'x', pattern: '(' }] }),
    ],
  ])('that %s decides nothing, with one stderr line', async (_label, text) => {
    await writeFile(join(dir, 'agent-rules.json'), text);
    const warn = vi.fn();
    expect(await loadAgentRules({ dataDir: dir, warn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('overrides one level deep, keeping the shipped values it leaves out', async () => {
    const balanced = { ...rules.costs.balanced, minProbability: 0.9 };
    await writeFile(join(dir, 'agent-rules.json'), JSON.stringify({ costs: { balanced } }));
    const strict = (await loadAgentRules({ dataDir: dir }))!;
    expect(strict.costs).toEqual({ ...rules.costs, balanced });
    const decision = await decideAgentRoute(spawn(), {
      rules: strict,
      jev: jev(answers({ choice: ROUTINE, confidence: 0.8 })),
      mode: 'apply',
    });
    expect(decision.route).toBe('keep');
  });
});

describe('settling by ratings, from the same answers', () => {
  const rated = (ratings: Parameters<typeof answers>[4], changes = 0.01) =>
    answers(sure('keep'), sure('keep'), 0.01, changes, ratings);
  const byRatings = (a: Answers, opts: { outside?: boolean } = {}) =>
    settle(spawn(), a, rules, { outside: opts.outside ?? false, by: 'ratings' });
  const light = { hard: 0.1, checkable: 0.9, costlyWrong: 0.1, biggerHelps: 0.1, effortHelps: 0.1 };

  it.each([
    ['light and checkable', light, 'haiku', 'medium'],
    ['in the middle', { ...light, hard: 0.4, checkable: 0.3 }, 'sonnet', 'medium'],
    ['hard', { ...light, hard: 0.8 }, undefined, 'high'],
    ['costly to get wrong', { ...light, costlyWrong: 0.7 }, undefined, 'medium'],
    ['helped by a bigger model', { ...light, biggerHelps: 0.6 }, undefined, 'medium'],
    ['helped by more effort', { ...light, effortHelps: 0.6 }, 'haiku', undefined],
  ] as const)('%s', (_label, ratings, model, effort) => {
    const settled = byRatings(rated(ratings));
    expect([settled.model, settled.effort]).toEqual([model, effort]);
    expect(settled.reason).toContain(`hard ${ratings.hard.toFixed(2)}`);
  });

  it('goes outside only when allowed, read-only and single-call', () => {
    expect(byRatings(rated(light), { outside: true })).toMatchObject({
      route: 'outside-read',
      destination: 'outside/deepseek/deepseek-v4.1-flash',
    });
    expect(byRatings(rated({ ...light, followUp: 0.5 }), { outside: true }).model).toBe('haiku');
    expect(byRatings(rated(light, 0.5), { outside: true }).model).toBe('haiku');
  });

  it('can disagree with the direct label on the same answers', () => {
    const same = rated(light);
    expect(settle(spawn(), same, rules, { outside: false, by: 'label' }).route).toBe('keep');
    expect(settle(spawn(), same, rules, { outside: false, by: 'ratings' }).route).toBe('claude');
  });
});

describe('the cost setting', () => {
  it('ships balanced', () => {
    expect(rules.cost).toBe('balanced');
  });

  it.each([
    [0.55, ['claude', 'keep', 'keep']],
    [0.7, ['claude', 'claude', 'keep']],
    [0.8, ['claude', 'claude', 'claude']],
  ] as const)('a label at %s moves under saver, balanced, quality: %o', (p, routes) => {
    const a = answers({ choice: ROUTINE, probabilities: { [ROUTINE]: p, keep: 1 - p } });
    const got = (['saver', 'balanced', 'quality'] as const).map(
      (cost) => settle(spawn(), a, rules, { outside: false, cost }).route,
    );
    expect(got).toEqual(routes);
  });
});

describe('the allow and exclude lists', () => {
  const lists = (allow: string[], exclude: string[]) => () => ({ ...rules, allow, exclude });
  const toLookup = answers(sure(LOOKUP), sure('low'));
  const toReader = answers(
    { choice: READER, probabilities: { [READER]: 0.9, keep: 0.1 } },
    undefined,
    0.01,
    0,
  );

  it.each([
    ['an excluded tier', lists([], ['claude/haiku']), toLookup],
    ['every outside model', lists([], ['outside/*']), toReader],
    ['one vendor by wildcard', lists([], ['outside/deepseek/*']), toReader],
    ['anything off the allow list', lists(['claude/*'], []), toReader],
  ] as const)('keeps the spawn as asked for %s', (_label, listed, a) => {
    expect(settle(spawn(), a, listed(), { outside: true })).toMatchObject({
      route: 'keep',
      why: 'excluded',
    });
  });

  it('leaves an allowed destination and an effort-only change alone', () => {
    const allowed = settle(spawn(), toLookup, lists(['claude/*'], ['outside/*'])(), {
      outside: true,
    });
    expect(allowed).toMatchObject({ route: 'claude', destination: 'claude/haiku' });
    const effortOnly = settle(
      spawn(),
      answers(sure('keep'), sure('low')),
      lists([], ['claude/*'])(),
      {
        outside: false,
      },
    );
    expect(effortOnly).toMatchObject({ route: 'claude', effort: 'medium' });
  });
});

describe('a reason and an estimate with every decision', () => {
  it('names the label and its numbers, and prices asked against chosen', async () => {
    const moved = await decide(spawn(), { jev: jev(answers(sure(ROUTINE), sure('medium'))) });
    expect(moved.reason).toContain(`label ${ROUTINE} 0.95`);
    // Opus at xhigh is 5; Sonnet two effort steps down is 3 x 0.75 x 0.85.
    expect(moved.estimate).toEqual({ asked: 5, chosen: 1.91 });
  });

  it.each([
    [
      'a floor',
      spawn({ brief: 'Review the diff to the payments signer.' }),
      'floor sensitive-review',
    ],
    ['a weak answer', spawn(), 'weak timeout'],
  ])('for %s too', async (_label, input, reason) => {
    const decision = await decide(input, { jev: jev({ weak: 'timeout' }) });
    expect(decision.reason).toBe(reason);
    expect(decision.estimate).toEqual({ asked: 5, chosen: 5 });
  });
});

describe('a re-spawn after a routed run', () => {
  const respawned = (routedTo: string, a: Answers) =>
    settle(spawn({ respawn: { routedTo } }), a, rules, { outside: true });

  it('goes at least one tier above the earlier run, keeping its effort as asked', () => {
    const settled = respawned('claude/haiku', answers(sure(ROUTINE), sure('low')));
    expect([settled.route, settled.model, settled.effort]).toEqual(['claude', 'sonnet', undefined]);
  });

  it.each([
    ['the same tier again', 'claude/sonnet', answers(sure(ROUTINE))],
    ['a lower tier', 'claude/sonnet', answers(sure(LOOKUP))],
    ['an effort-only change', 'claude/haiku', answers(sure('keep'), sure('low'))],
    [
      'the middle tier after an outside read',
      'outside/deepseek/deepseek-v4.1-flash',
      answers(sure(ROUTINE)),
    ],
    [
      'outside again',
      'claude/haiku',
      answers({ choice: READER, probabilities: { [READER]: 0.9, keep: 0.1 } }, undefined, 0.01, 0),
    ],
  ] as const)('keeps for %s', (_label, routedTo, a) => {
    expect(respawned(routedTo, a)).toMatchObject({ route: 'keep', why: 'respawn' });
  });
});

describe('only the brief and the spawn facts go to Jev', () => {
  const harness = [
    '<system-reminder>REMINDER-TEXT</system-reminder>',
    '<local-command-stdout>TOOL-OUTPUT</local-command-stdout>',
    '<bash-stdout>BASH-OUTPUT</bash-stdout>',
  ].join('\n');

  it('strips system reminders and tool output from the brief, description and user words', () => {
    const request = jevRequest(
      spawn({
        brief: `Find the reader.\n${harness}\n<function_results>UNCLOSED-OUTPUT`,
        description: `Find it <system-reminder>DESC-REMINDER</system-reminder>`,
        latestUserInstruction: `look into it ${harness}`,
      }),
      rules,
    )!;
    const sent = JSON.stringify(request.state);
    for (const leak of [
      'REMINDER',
      'TOOL-OUTPUT',
      'BASH-OUTPUT',
      'UNCLOSED-OUTPUT',
      'DESC-REMINDER',
    ]) {
      expect(sent).not.toContain(leak);
    }
    expect(sent).toContain('Find the reader.');
  });

  it('never floors on text inside a system reminder', async () => {
    const brief = 'Review PR 12.\n<system-reminder>x402 payments wallet signer</system-reminder>';
    expect((await decide(spawn({ brief }), { jev: jev(answers(sure('keep'))) })).floors).toEqual(
      [],
    );
  });
});

describe('the parent slice', () => {
  const withParent = () => ({ ...rules, context: 'brief+parent' as const });
  type Sent = { parentContext?: { messages: { role: string; text: string }[] } };
  const sliceOf = (parent: SpawnInput['parent'], r: AgentRules = withParent()) => {
    const request = jevRequest(spawn({ parent }), r)!;
    return { request, slice: (request.state as Sent).parentContext?.messages };
  };

  it('goes in by default, and is left out when the rules say brief', () => {
    expect(rules.context).toBe('brief+parent');
    expect(sliceOf([{ role: 'user', text: 'look into it' }], rules).slice).toEqual([
      { role: 'user', text: 'look into it' },
    ]);
    const brief = { ...rules, context: 'brief' as const };
    expect(sliceOf([{ role: 'user', text: 'look into it' }], brief).slice).toBeUndefined();
  });

  it('keeps to the bounds the rules set, and the rules refuse bounds past 16,000 and 12', async () => {
    const parent = Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const,
      text: `MESSAGE-${i} ${'x'.repeat(100)}`,
    }));
    const { slice } = sliceOf(parent, { ...withParent(), parentChars: 16_000, parentMessages: 3 });
    expect(slice!.map((m) => m.text.slice(0, 9))).toEqual(['MESSAGE-7', 'MESSAGE-8', 'MESSAGE-9']);
    const tight = sliceOf(parent, { ...withParent(), parentChars: 150, parentMessages: 12 }).slice!;
    expect(tight.reduce((sum, m) => sum + m.text.length, 0)).toBeLessThanOrEqual(150);
    const fs = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await fs.mkdtemp(join(tmpdir(), 'agent-rules-bounds-'));
    try {
      for (const over of [{ parentChars: 16_001 }, { parentMessages: 13 }]) {
        const path = join(dir, 'agent-rules.json');
        await fs.writeFile(path, JSON.stringify(over));
        expect(await loadAgentRules({ path, warn: () => undefined })).toBeNull();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the newest messages, in order, within the size bound', () => {
    const parent = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      text: `MESSAGE-${i} ${'x'.repeat(1_200)}`,
    }));
    const { slice } = sliceOf(parent);
    const total = slice!.reduce((sum, m) => sum + m.text.length, 0);
    expect(total).toBeLessThanOrEqual(4_000);
    expect(slice!.at(-1)!.text).toContain('MESSAGE-9');
    expect(slice!.some((m) => m.text.includes('MESSAGE-5'))).toBe(false);
  });

  it('strips system reminders and tool output from each message', () => {
    const { slice } = sliceOf([
      { role: 'user', text: 'fix it <system-reminder>REMINDER</system-reminder>' },
      { role: 'assistant', text: 'ran it <bash-stdout>OUTPUT</bash-stdout>' },
    ]);
    expect(JSON.stringify(slice)).not.toMatch(/REMINDER|OUTPUT/);
  });

  it('goes without the slice, not without the brief, when the mask would change it', () => {
    const { request, slice } = sliceOf([{ role: 'user', text: `use ${TOKEN}` }]);
    expect(slice).toBeUndefined();
    expect(request.parentSent).toBe(false);
    expect(JSON.stringify(request.state)).toContain('Find where the config file is read');
  });
});
