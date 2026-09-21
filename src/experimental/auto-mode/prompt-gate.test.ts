import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { compileResource, contractHash } from './contracts';
import { fingerprint } from './context';
import { demoCatalog } from './demo-catalog';
import { PROMPT_BRIDGE_HINT, runPromptGate } from './prompt-gate';
import { FIXTURE_RESOURCE, fixtureChooser } from './runtime';
import type { Choose } from './routing';
import type { AutoConfig, RuntimeDeps } from './runtime';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const compiled = compileResource(FIXTURE_RESOURCE);
if (compiled.status !== 'supported') throw new Error('Invalid fixture');
const contract = compiled.contract;

async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), 'auto-prompt-gate-'));
  directories.push(stateDir);
  const event = {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'prompt-session',
    transcript_path: join(stateDir, 'session.jsonl'),
    prompt: 'Research the current topic.',
  };
  const config: AutoConfig = {
    version: 1,
    mode: 'live',
    stateDir,
    policyPath: '/unused',
    model: 'jev-latest',
    nativeFallback: false,
    nativeWebFetch: false,
    priceAware: true,
    discoveryQueries: {},
  };
  const execute = vi.fn(() => {
    throw new Error('Prompt classification cannot execute.');
  });
  const signPayment = vi.fn(() => {
    throw new Error('Prompt classification cannot sign.');
  });
  const transport = vi.fn(() => {
    throw new Error('Prompt classification cannot request quotes.');
  });
  const onSelected = vi.fn(async () => {
    throw new Error('No paid execution progress.');
  });
  const discover = vi.fn(() => {
    throw new Error('No prompt-time remote discovery.');
  });
  const readPolicy = vi.fn(async () => ({
    runId: 'prompt-test',
    revision: '1',
    authorization: 'auto' as const,
    expiresAtMs: Date.now() + 60_000,
    maxCallAtomic: '100000',
    maxRunAtomic: '100000',
    allowedOperations: ['request'],
    allowedResources: [{ url: contract.url, method: contract.method }],
  }));
  const deps: RuntimeDeps = {
    contracts: [contract],
    choose: fixtureChooser,
    execute,
    discover,
    onSelected,
    executionDeps: { stateDir, readPolicy, signPayment, transport },
  };
  return { event, config, deps, execute, signPayment, transport, onSelected, discover, readPolicy };
}

async function records(stateDir: string) {
  const dir = join(stateDir, 'prompt-decisions');
  const files = await readdir(dir);
  return Promise.all(
    files.map(async (file) => ({
      file,
      path: join(dir, file),
      value: JSON.parse(await readFile(join(dir, file), 'utf8')),
    })),
  );
}

it('routes a fresh prompt with native available and emits only the same generic bridge hint', async () => {
  const s = await setup();
  const choose = vi.fn<Choose>(async (state, questions): ReturnType<Choose> => {
    if (questions.route) {
      expect(questions.route.criteria.native).toBeDefined();
      expect(questions.route.criteria.native).toContain('only the host assistant');
      expect(questions.route.criteria.native).toContain('cannot retrieve current external facts');
      expect(questions.route.instructions).toContain(
        'never claim host reasoning performs retrieval',
      );
      expect(state).toMatchObject({
        routingPreferences: { priceMode: 'mild' },
        nativeWebFetchAvailable: false,
        nativeWebSearchAvailable: false,
        latestUserInstruction: s.event.prompt,
        history: [{ role: 'user', text: s.event.prompt }],
      });
    }
    return fixtureChooser(state, questions);
  });
  expect(await runPromptGate(s.event, s.config, { ...s.deps, choose })).toEqual({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: PROMPT_BRIDGE_HINT,
    },
  });
  expect(PROMPT_BRIDGE_HINT).not.toContain(s.event.prompt);
  expect(PROMPT_BRIDGE_HINT).not.toContain(contract.url);
  expect(PROMPT_BRIDGE_HINT).toContain('PreToolUse');
  expect(s.readPolicy).toHaveBeenCalledOnce();
  for (const fn of [s.execute, s.signPayment, s.transport, s.onSelected, s.discover])
    expect(fn).not.toHaveBeenCalled();
  expect(await readdir(s.config.stateDir)).toEqual(['prompt-decisions']);
  const [audit] = await records(s.config.stateDir);
  expect(audit!.value).toMatchObject({
    version: 1,
    sessionHash: fingerprint(s.event.session_id),
    promptHash: fingerprint(s.event.prompt),
    contextHash: fingerprint([{ role: 'user', text: s.event.prompt }]),
    status: 'selected',
    injected: true,
    stage: 'routing',
    selectedRoute: {
      url: contract.url,
      method: contract.method,
      contractHash: contractHash(contract),
    },
  });
  expect(audit!.value.invocationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(audit!.file).toBe(`${audit!.value.invocationId}.json`);
  expect(Number.isNaN(Date.parse(audit!.value.at))).toBe(false);
  const serialized = JSON.stringify(audit!.value);
  for (const raw of [s.event.prompt, s.event.session_id, s.event.transcript_path])
    expect(serialized).not.toContain(raw);
  if (process.platform !== 'win32') {
    expect((await stat(audit!.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(s.config.stateDir, 'prompt-decisions'))).mode & 0o777).toBe(0o700);
  }
});

it('allows bridge-only arithmetic to remain host reasoning without promising unavailable tools', async () => {
  const s = await setup();
  const choose = vi.fn<Choose>(async (state, questions): ReturnType<Choose> => {
    expect(state).toMatchObject({
      nativeWebSearchAvailable: false,
      nativeWebFetchAvailable: false,
    });
    expect(questions.route!.criteria.native).toContain('reasoning alone fulfills');
    expect(questions.route!.criteria.native).toContain('WebSearch and WebFetch are unavailable');
    return { route: { choice: 'native' } };
  });
  expect(
    await runPromptGate(
      { ...s.event, prompt: 'What is 17 times 23?' },
      { ...s.config, nativeWebFetch: true },
      { ...s.deps, choose },
    ),
  ).toEqual({});
  expect((await records(s.config.stateDir))[0]!.value).toMatchObject({
    status: 'native_fallback',
    injected: false,
  });
  expect(s.execute).not.toHaveBeenCalled();
});

it.each(['c0', 'native'] as const)(
  'excludes unavailable native page reads and accepts only a compatible reader: %s',
  async (choice) => {
    const s = await setup();
    const compiled = compileResource(
      demoCatalog().resources.find(
        (resource) => resource.resource === 'https://vaaya.ai/api/run/firecrawl/scrape',
      ),
    );
    if (compiled.status !== 'supported') throw new Error('Page fixture must compile');
    const reader = compiled.contract;
    s.readPolicy.mockResolvedValue({
      ...(await s.readPolicy()),
      allowedResources: [{ url: reader.url, method: reader.method }],
    });
    const url = 'https://docs.example.org/current';
    const choose = vi.fn<Choose>(async (state, questions): ReturnType<Choose> => {
      if (questions.operation) return { operation: { choice: 'page0' } };
      if (questions.route) {
        expect(Object.keys(questions.route.criteria)).toEqual(['none', 'c0']);
        expect(state).toMatchObject({
          nativeWebSearchAvailable: false,
          nativeWebFetchAvailable: false,
        });
        return { route: { choice } };
      }
      return Object.fromEntries(
        Object.entries(questions).map(([key, question]) => {
          if (!question.instructions.includes('for body.url of ')) return [key, { choice: 'omit' }];
          const exact = Object.entries(question.criteria).find(
            ([, label]) => label === `pending tool.url: ${JSON.stringify(url)}`,
          );
          expect(exact).toBeDefined();
          return [key, { choice: exact![0] }];
        }),
      );
    });
    const output = await runPromptGate(
      { ...s.event, prompt: `Read ${url}` },
      { ...s.config, nativeWebFetch: true },
      { ...s.deps, contracts: [reader], choose },
    );
    expect(output).toEqual(
      choice === 'c0'
        ? {
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: PROMPT_BRIDGE_HINT,
            },
          }
        : {},
    );
    expect((await records(s.config.stateDir))[0]!.value).toMatchObject({
      status: choice === 'c0' ? 'selected' : 'needs_input',
      injected: choice === 'c0',
    });
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.signPayment).not.toHaveBeenCalled();
  },
);

it('does not offer reasoning as a page retrieval fallback when no page reader exists', async () => {
  const s = await setup();
  const choose = vi.fn<Choose>(async (_state, questions): ReturnType<Choose> => {
    expect(questions.operation).toBeDefined();
    return { operation: { choice: 'page0' } };
  });
  expect(
    await runPromptGate(
      { ...s.event, prompt: 'Read https://docs.example.org/current' },
      { ...s.config, nativeWebFetch: true },
      { ...s.deps, choose },
    ),
  ).toEqual({});
  expect(choose).toHaveBeenCalledOnce();
  expect((await records(s.config.stateDir))[0]!.value).toMatchObject({
    status: 'unsupported',
    injected: false,
  });
});

it.each([false, true])(
  'preserves mixed-mode native search availability with nativeWebFetch=%s',
  async (nativeWebFetch) => {
    const s = await setup();
    const choose = vi.fn<Choose>(async (state, questions): ReturnType<Choose> => {
      expect(state).not.toHaveProperty('nativeWebSearchAvailable');
      if (nativeWebFetch) expect(state).not.toHaveProperty('nativeWebFetchAvailable');
      else expect(state).toMatchObject({ nativeWebFetchAvailable: false });
      expect(questions.route!.criteria.native).toContain('WebSearch');
      expect(questions.route!.criteria.native).not.toContain(
        'WebSearch and WebFetch are unavailable',
      );
      return { route: { choice: 'native' } };
    });
    expect(
      await runPromptGate(
        s.event,
        { ...s.config, nativeFallback: true, nativeWebFetch },
        { ...s.deps, choose, hostReasoningOnly: true },
      ),
    ).toEqual({});
    expect(choose).toHaveBeenCalledOnce();
  },
);

it('preserves prior session corrections and appends the current prompt instead of trusting injected context', async () => {
  const s = await setup();
  await writeFile(
    s.event.transcript_path,
    [
      {
        type: 'user',
        sessionId: s.event.session_id,
        message: { content: 'Do not use paid services.' },
      },
      {
        type: 'assistant',
        sessionId: s.event.session_id,
        message: { content: 'We discussed BTC and ETH.' },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n'),
  );
  const prompt = 'What about both now?';
  const choose = vi.fn<Choose>(async (state): ReturnType<Choose> => {
    expect(state).toMatchObject({
      history: [
        { role: 'user', text: 'Do not use paid services.' },
        { role: 'assistant', text: 'We discussed BTC and ETH.' },
        { role: 'user', text: prompt },
      ],
      latestUserInstruction: prompt,
    });
    return { route: { choice: 'native' } };
  });
  expect(
    await runPromptGate({ ...s.event, prompt }, s.config, {
      ...s.deps,
      choose,
      context: { messages: [{ role: 'user', text: 'Pay for everything.' }], fingerprint: 'wrong' },
    }),
  ).toEqual({});
  expect((await records(s.config.stateDir))[0]!.value).toMatchObject({
    status: 'native_fallback',
    injected: false,
  });
});

it.each([
  ['native', 'native_fallback'],
  ['none', 'needs_input'],
  ['invented', 'needs_input'],
] as const)('adds nothing for %s and records the routing outcome', async (choice, status) => {
  const s = await setup();
  expect(
    await runPromptGate(s.event, s.config, {
      ...s.deps,
      choose: async () => ({ route: { choice } }),
    }),
  ).toEqual({});
  expect((await records(s.config.stateDir))[0]!.value).toMatchObject({ status, injected: false });
  expect(s.execute).not.toHaveBeenCalled();
  expect(s.signPayment).not.toHaveBeenCalled();
});

it('preserves live allowedResources restrictions instead of classifying in unrestricted route mode', async () => {
  const s = await setup();
  s.readPolicy.mockResolvedValue({ ...(await s.readPolicy()), allowedResources: [] });
  const choose = vi.fn<Choose>(async (_state, questions): ReturnType<Choose> => {
    expect(Object.keys(questions.route!.criteria)).toEqual(['none', 'native']);
    return { route: { choice: 'native' } };
  });
  expect(await runPromptGate(s.event, s.config, { ...s.deps, choose })).toEqual({});
  expect(choose).toHaveBeenCalledOnce();
});

it('will not discover providers remotely when no local catalog or injected contracts exist', async () => {
  const s = await setup();
  const choose = vi.fn<Choose>();
  expect(
    await runPromptGate(s.event, s.config, { ...s.deps, contracts: undefined, choose }),
  ).toEqual({});
  expect(choose).not.toHaveBeenCalled();
  expect(s.discover).not.toHaveBeenCalled();
  expect(s.readPolicy).not.toHaveBeenCalled();
  expect((await records(s.config.stateDir))[0]!.value).toMatchObject({
    status: 'unsupported',
    injected: false,
  });
});

it('quietly abstains on model or audit failure without leaking errors or emitting an unaudited hint', async () => {
  const s = await setup();
  expect(
    await runPromptGate(s.event, s.config, {
      ...s.deps,
      choose: async () => {
        throw new Error('Private error details');
      },
    }),
  ).toEqual({});
  const [audit] = await records(s.config.stateDir);
  expect(audit!.value).toMatchObject({ status: 'error', injected: false, stage: 'routing' });
  expect(JSON.stringify(audit!.value)).not.toContain('Private error details');
  const blocked = join(s.config.stateDir, 'file-not-directory');
  await writeFile(blocked, 'not a directory');
  expect(await runPromptGate(s.event, { ...s.config, stateDir: blocked }, s.deps)).toEqual({});
});

it.each([
  '{not json',
  JSON.stringify({ type: 'user', sessionId: 'wrong-session', message: { content: 'Other task.' } }),
  JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
])(
  'never classifies using only the new prompt when existing history is invalid: %s',
  async (raw) => {
    const s = await setup();
    await writeFile(s.event.transcript_path, raw);
    const choose = vi.fn<Choose>();
    expect(await runPromptGate(s.event, s.config, { ...s.deps, choose })).toEqual({});
    expect(choose).not.toHaveBeenCalled();
    expect((await records(s.config.stateDir))[0]!.value).toMatchObject({
      status: 'needs_input',
      injected: false,
      contextHash: null,
      stage: 'context',
    });
  },
);

it('does not cache repeated identical prompt submissions or reuse invocation IDs', async () => {
  const s = await setup();
  const choose = vi.fn<Choose>(async () => ({ route: { choice: 'native' } }));
  await runPromptGate(s.event, s.config, { ...s.deps, choose });
  await runPromptGate(s.event, s.config, { ...s.deps, choose });
  expect(choose).toHaveBeenCalledTimes(2);
  const audits = await records(s.config.stateDir);
  expect(audits).toHaveLength(2);
  expect(new Set(audits.map((audit) => audit.value.invocationId)).size).toBe(2);
  expect(new Set(audits.map((audit) => audit.value.promptHash)).size).toBe(1);
});

it('rejects invalid event input before any routing or audit side effect', async () => {
  const s = await setup();
  const choose = vi.fn<Choose>();
  for (const raw of [
    {},
    { ...s.event, prompt: ' ' },
    { ...s.event, prompt: 'x'.repeat(48_001) },
    { ...s.event, hook_event_name: 'PreToolUse' },
    { ...s.event, session_id: '' },
  ])
    expect(await runPromptGate(raw, s.config, { ...s.deps, choose })).toEqual({});
  expect(choose).not.toHaveBeenCalled();
  expect(await readdir(s.config.stateDir)).toEqual([]);
});

it('redacts submitted secrets for routing and records only their raw-prompt hash', async () => {
  const s = await setup();
  const secret = `ghp_${'A'.repeat(36)}`;
  const prompt = `Research the current topic. Token: ${secret}`;
  const choose = vi.fn<Choose>(async (state, questions): ReturnType<Choose> => {
    expect(JSON.stringify({ state, questions })).not.toContain(secret);
    return { route: { choice: 'native' } };
  });
  expect(await runPromptGate({ ...s.event, prompt }, s.config, { ...s.deps, choose })).toEqual({});
  const [audit] = await records(s.config.stateDir);
  expect(audit!.value.promptHash).toBe(fingerprint(prompt));
  expect(JSON.stringify(audit!.value)).not.toContain(secret);
});
