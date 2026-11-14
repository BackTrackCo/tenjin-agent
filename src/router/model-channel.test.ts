import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, expect, it } from 'vitest';
import { FakeRouter, payerDeps, TEST_POLICY } from './fee-test-utils';
import { RoutingPayer } from './routing-payer';
import { ModelTransport } from './model-transport';
import { ROUTE_PAID_PATH } from './decision';
import type { ModelPaymentPath } from './model-channel';

let dir: string;
const payers: RoutingPayer[] = [];
afterEach(async () => {
  await Promise.all(payers.splice(0).map((payer) => payer.idle()));
  if (dir) await rm(dir, { recursive: true, force: true });
});

it('funds independent SDK channels for tools, model routing and inference at each server origin, and reuses each model channel', async () => {
  dir = await mkdtemp(join(tmpdir(), 'model-channel-isolation-'));
  const server = new FakeRouter();
  const wallet = privateKeyToAccount(generatePrivateKey());
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    // One facilitator/payee/asset for every lane and origin. URL alone must
    // not be the thing that keeps their SDK channel IDs apart.
    return server.fetch(
      new Request(new URL(ROUTE_PAID_PATH, request.url), {
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      }),
    );
  };
  const deps = payerDeps(server, dir, wallet, { fetchImpl });
  const tool = new RoutingPayer(deps);
  payers.push(tool);
  await tool.routeFor('https://router.test').send(`https://router.test${ROUTE_PAID_PATH}`, {
    method: 'POST',
    jsonBody: {},
    timeoutMs: 5000,
  });
  for (const origin of ['https://router.test', 'http://localhost:3939']) {
    await new ModelTransport({ dataDir: dir, baseUrl: origin, payerDeps: deps }).route({
      schemaVersion: 1,
    });
    const inference = new RoutingPayer({
      ...deps,
      modelLane: { path: '/api/model-proxy/messages', origin, ceilingAtomic: 3000n },
    });
    payers.push(inference);
    await inference.routeFor(origin).send(`${origin}/api/model-proxy/messages`, {
      method: 'POST',
      jsonBody: {},
      timeoutMs: 5000,
    });
  }
  expect(server.channels.size).toBe(5);
  expect(server.deposits).toBe(5);
  const before = new Set(server.channels.keys());
  for (const origin of ['https://router.test', 'http://localhost:3939']) {
    await new ModelTransport({ dataDir: dir, baseUrl: origin, payerDeps: deps }).route({
      schemaVersion: 1,
    });
    const inference = new RoutingPayer({
      ...deps,
      modelLane: { path: '/api/model-proxy/responses', origin, ceilingAtomic: 3000n },
    });
    payers.push(inference);
    await inference.routeFor(origin).send(`${origin}/api/model-proxy/responses`, {
      method: 'POST',
      jsonBody: {},
      timeoutMs: 5000,
    });
  }
  expect(new Set(server.channels.keys())).toEqual(before);
  expect(server.deposits).toBe(5);
});

it('keeps model-routing fees at $0.003 and ordinary deposit liquidity while binding a lane to its origin', async () => {
  dir = await mkdtemp(join(tmpdir(), 'model-route-ceiling-'));
  const server = new FakeRouter({ path: '/api/model-router/route', minDeposit: '1000000' });
  const deps = payerDeps(server, dir, privateKeyToAccount(generatePrivateKey()), {
    policy: async () => ({ ...TEST_POLICY, maxAutoSpendAtomic: 1000000n }),
  });
  const transport = new ModelTransport({
    dataDir: dir,
    baseUrl: 'https://router.test',
    payerDeps: deps,
  });
  await transport.route({ schemaVersion: 1 });
  expect([...server.channels.values()][0]!.balance).toBe(250000n);
  server.requirement.amount = '3001';
  await expect(transport.route({ schemaVersion: 1 })).rejects.toThrow();
  expect(server.paidRequests()).toBe(1);
  for (const path of [
    '/api/model-router/route',
    '/api/model-proxy/messages',
    '/api/model-proxy/responses',
  ] as ModelPaymentPath[]) {
    const payer = new RoutingPayer({
      ...deps,
      modelLane: { path, origin: 'https://router.test', ceilingAtomic: 1000000n },
    });
    payers.push(payer);
    await expect(
      payer
        .routeFor('http://localhost:3939')
        .send(`http://localhost:3939${path}`, { method: 'POST', jsonBody: {}, timeoutMs: 5000 }),
    ).rejects.toThrow();
  }
  expect(server.paidRequests()).toBe(1);
});
