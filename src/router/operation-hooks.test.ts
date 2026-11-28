import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROUTE_PAID_PATH, ROUTER_PATH, RouteSkipped, type DecisionRoute } from './decision';
import { runPromptHook, type HookDeps } from './hooks';
import { readOffer } from './operation-store';
import { recordTermsTold } from './terms-notice';

/**
 * THE HOOK LEG'S OFFER OF TASKS. It comes from the free route as a plain
 * request, so it needs no wallet, takes no turn on the routing channel and is
 * never skipped behind a busy one, and no offer makes a routing payment.
 */

const BASE = 'https://router.test';
const OFFER_ID = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d01';
const LINE = `Call request(${JSON.stringify({ operation: 'x-post-search', input: { query: '<query>' } })}) alone and wait for its result.`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-operation-hooks-'));
  await mkdir(join(dir, '.git'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      maxAutoSpend: '250000',
      sessionBudget: '5000000',
      install: { improveAsked: true },
    }),
  );
  await recordTermsTold(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function router(answer: 'offer' | 'fee_required'): {
  fetchImpl: typeof fetch;
  urls: string[];
  bodies: Record<string, unknown>[];
} {
  const urls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    urls.push(String(input));
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    const decision =
      answer === 'offer' && String(input).endsWith(ROUTER_PATH)
        ? {
            action: 'offer',
            id: OFFER_ID,
            task: 'x post search',
            operations: [
              {
                operation: 'x-post-search',
                label: 'X post search',
                does: 'finds posts',
                price: '$0.0058',
              },
            ],
            hint: LINE,
          }
        : {
            action: 'native',
            reason: 'No.',
            diagnostics: {
              reasonCode: answer === 'fee_required' ? 'fee_required' : 'native_sufficient',
              stage: 'capability',
              missing: [],
              nextAction: 'x',
            },
          };
    return new Response(JSON.stringify({ schemaVersion: 1, routerVersion: 'v', decision }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, urls, bodies };
}

function prompt(): unknown {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess-1',
    cwd: dir,
    prompt: 'search X for recent posts about x402 with at least five likes',
  };
}

function deps(fetchImpl: typeof fetch, route?: HookDeps['route']): HookDeps {
  return {
    dataDir: dir,
    baseUrl: BASE,
    fetchImpl,
    now: () => 1_800_000_000_000,
    warn: () => undefined,
    // No wallet key: nothing here can sign.
    env: {},
    ...(route !== undefined ? { route } : {}),
  };
}

describe('the prompt leg with a router that offers operations', () => {
  it('shows the offer with no wallet and no payer, and keeps it by its id', async () => {
    const fake = router('offer');
    const outcome = await runPromptHook(prompt(), deps(fake.fetchImpl));
    expect(outcome.action).toBe('offer');
    expect(JSON.stringify(outcome.response)).toContain('alone and wait for its result');
    expect(JSON.stringify(outcome.response)).toContain('x-post-search');
    expect(fake.urls).toEqual([`${BASE}${ROUTER_PATH}`]);
    expect((fake.bodies[0]!.accepts as string[]).includes('operation')).toBe(true);
    expect((await readOffer(dir, OFFER_ID))?.operations[0]?.operation).toBe('x-post-search');
  });

  it('is never skipped behind a busy channel, and makes no routing payment', async () => {
    const fake = router('offer');
    let sent = 0;
    const route: HookDeps['route'] = () =>
      ({
        send: async () => {
          sent += 1;
          throw new RouteSkipped('channel_busy');
        },
      }) as DecisionRoute;
    const outcome = await runPromptHook(prompt(), deps(fake.fetchImpl, route));
    expect(outcome.action).toBe('offer');
    expect(sent).toBe(0);
    expect(fake.urls.every((url) => !url.endsWith(ROUTE_PAID_PATH))).toBe(true);
  });
});

describe('the prompt leg with a router that predates routed operations', () => {
  it('asks the free route once, then sends the call to the paid route as it always did', async () => {
    const fake = router('fee_required');
    await runPromptHook(prompt(), deps(fake.fetchImpl));
    expect(fake.urls).toEqual([`${BASE}${ROUTER_PATH}`, `${BASE}${ROUTE_PAID_PATH}`]);
    expect((fake.bodies[0]!.accepts as string[]).includes('operation')).toBe(true);
    expect((fake.bodies[1]!.accepts as string[]).includes('operation')).toBe(false);
    // A second prompt goes straight to the paid route.
    await runPromptHook(prompt(), deps(fake.fetchImpl));
    expect(fake.urls.slice(2)).toEqual([`${BASE}${ROUTE_PAID_PATH}`]);
  });
});
