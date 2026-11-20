import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, expect, it, vi } from 'vitest';
import { FakeRouter, payerDeps, TEST_POLICY } from './fee-test-utils';
import { RoutingPayer } from './routing-payer';
import { ModelTransport } from './model-transport';
import { ROUTE_PAID_PATH } from './decision';
import { modelChannelScope, type ModelPaymentPath } from './model-channel';
import { FEE_ABOVE_CEILING, ROUTING_FEE_CEILING_ATOMIC } from './fee';

let dir: string;
const payers: RoutingPayer[] = [];
afterEach(async () => {
  await Promise.all(payers.splice(0).map((payer) => payer.idle()));
  if (dir) await rm(dir, { recursive: true, force: true });
});

it('keeps the original channel salts and scopes each channel by origin', () => {
  const origin = 'https://router.test';
  const primary = modelChannelScope(origin, 'model-inference');
  const routing = modelChannelScope(origin, 'model-routing');
  // Existing funded channels are identified by these salts onchain.
  expect(primary.salt).toBe('0x428f2d5b25cde2721c60f0be6187c4aff939727a2c38e051c5c0e5a4a3a6f560');
  expect(routing.salt).toBe('0x698b515e6066903a36d0a55ef272ac2e8a97b4e7f906eb7f268d3d567d811a27');
  expect(modelChannelScope(origin, 'model-inference')).toEqual(primary);
  expect(modelChannelScope(origin, 'model-routing')).toEqual(routing);
  expect(modelChannelScope(origin + '/api/model-proxy/messages', 'model-inference')).toEqual(
    primary,
  );
  expect(modelChannelScope('http://localhost:3939', 'model-inference').salt).not.toBe(primary.salt);
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

it('pays a model-routing fee up to the tool router ceiling with ordinary deposit liquidity while binding a lane to its origin', async () => {
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
  await expect(transport.route({ schemaVersion: 1 })).resolves.toMatchObject({
    authorizedAtomic: 3001n,
  });
  expect(server.paidRequests()).toBe(2);
  server.requirement.amount = (ROUTING_FEE_CEILING_ATOMIC + 1n).toString();
  await expect(transport.route({ schemaVersion: 1 })).rejects.toThrow();
  expect(server.paidRequests()).toBe(2);
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
  expect(server.paidRequests()).toBe(2);
});
it('rejects a model-route quote above the tool router ceiling before unlocking even when its caller supplies a larger ceiling', async () => {
  dir = await mkdtemp(join(tmpdir(), 'model-route-independent-cap-'));
  const server = new FakeRouter({
    path: '/api/model-router/route',
    amount: (ROUTING_FEE_CEILING_ATOMIC + 1n).toString(),
  });
  const deps = payerDeps(server, dir, privateKeyToAccount(generatePrivateKey()));
  const getSigner = vi.fn(deps.getSigner);
  const payer = new RoutingPayer({
    ...deps,
    getSigner,
    modelLane: {
      path: '/api/model-router/route',
      origin: 'https://router.test',
      ceilingAtomic: 1000000n,
    },
  });
  payers.push(payer);
  await expect(
    payer.routeFor('https://router.test').send('https://router.test/api/model-router/route', {
      method: 'POST',
      jsonBody: {},
      timeoutMs: 5000,
    }),
  ).rejects.toMatchObject({ why: FEE_ABOVE_CEILING });
  expect(getSigner).not.toHaveBeenCalled();
  expect(server.paidRequests()).toBe(0);
});
it('pays a model-route answer its own quote ahead of the fixed one, as the tool router does', async () => {
  dir = await mkdtemp(join(tmpdir(), 'model-route-offer-cap-'));
  const server = new FakeRouter({ path: '/api/model-router/route', amount: '31500', legacy: true });
  const transport = new ModelTransport({
    dataDir: dir,
    baseUrl: 'https://router.test',
    payerDeps: payerDeps(server, dir, privateKeyToAccount(generatePrivateKey())),
  });
  await transport.route({ schemaVersion: 1 });
  expect(server.paidAmounts).toEqual([31500n]);
  expect(server.warms).toBe(0);
});

it('skips a quote the job cap leaves no room for, before unlocking, and says the amount it stated', async () => {
  dir = await mkdtemp(join(tmpdir(), 'model-route-job-room-'));
  const server = new FakeRouter({ path: '/api/model-router/route', amount: '8100' });
  const deps = payerDeps(server, dir, privateKeyToAccount(generatePrivateKey()));
  const getSigner = vi.fn(deps.getSigner);
  const transport = new ModelTransport({
    dataDir: dir,
    baseUrl: 'https://router.test',
    payerDeps: { ...deps, getSigner },
  });
  await expect(
    transport.route({ schemaVersion: 1 }, undefined, undefined, undefined, 8099n),
  ).rejects.toMatchObject({ why: FEE_ABOVE_CEILING, quotedAtomic: 8100n });
  expect(getSigner).not.toHaveBeenCalled();
  expect(server.paidRequests()).toBe(0);
  await expect(
    transport.route({ schemaVersion: 1 }, undefined, undefined, undefined, 8100n),
  ).resolves.toMatchObject({ authorizedAtomic: 8100n });
  expect(server.paidAmounts).toEqual([8100n]);
});

it('says no fee was authorized for a routing call the router answered without a payment', async () => {
  dir = await mkdtemp(join(tmpdir(), 'model-route-free-'));
  const server = new FakeRouter({ path: '/api/model-router/route', paid: false });
  const transport = new ModelTransport({
    dataDir: dir,
    baseUrl: 'https://router.test',
    payerDeps: payerDeps(server, dir, privateKeyToAccount(generatePrivateKey())),
  });
  await expect(transport.route({ schemaVersion: 1 })).resolves.toMatchObject({
    authorizedAtomic: 0n,
  });
});

function routingTransport(server: FakeRouter, policy = {}) {
  const transport = new ModelTransport({
    dataDir: dir,
    baseUrl: 'https://router.test',
    payerDeps: payerDeps(server, dir, privateKeyToAccount(generatePrivateKey()), {
      policy: async () => ({ ...TEST_POLICY, ...policy }),
    }),
  });
  return transport;
}

// The router states the fee on its 402 and this client pays it. Nothing in the client
// names a number: it authorizes exactly what the call stated.
it.each([
  ['a small one', '1200'],
  ['about 8,100', '8100'],
  ['a larger one', '200000'],
  ['one at the ceiling', ROUTING_FEE_CEILING_ATOMIC.toString()],
])('pays and records the fee %s states, and authorizes exactly it', async (_name, amount) => {
  dir = await mkdtemp(join(tmpdir(), 'model-route-compat-'));
  const server = new FakeRouter({ path: '/api/model-router/route', amount, charge: amount });
  const answered = await routingTransport(server).route({ schemaVersion: 1 });
  expect(answered.authorizedAtomic).toBe(BigInt(amount));
  expect(server.paidAmounts).toEqual([BigInt(amount)]);
  expect([...server.channels.values()][0]!.charged).toBe(BigInt(amount));
});

it('keeps a channel the fee never charges: a quote the server then charges nothing for costs nothing', async () => {
  dir = await mkdtemp(join(tmpdir(), 'model-route-nooffer-'));
  const server = new FakeRouter({ path: '/api/model-router/route', amount: '8100', charge: '0' });
  const answered = await routingTransport(server).route({ schemaVersion: 1 });
  expect(answered.authorizedAtomic).toBe(8100n);
  expect([...server.channels.values()][0]!.charged).toBe(0n);
});

// A batch of held offers asks for its routing calls together. Each is authorized for its own
// stated fee; together they stay inside the routing channel and the person's limits.
it('authorizes a batch of five routing calls fee by fee, inside the channel and the daily budget', async () => {
  dir = await mkdtemp(join(tmpdir(), 'model-route-batch-'));
  const server = new FakeRouter({ path: '/api/model-router/route', amount: '200000' });
  const transport = routingTransport(server, { sessionBudgetAtomic: 5_000_000n });
  const answers = await Promise.all(
    [1, 2, 3, 4, 5].map(() => transport.route({ schemaVersion: 1 })),
  );
  expect(answers.map((a) => a.authorizedAtomic)).toEqual(Array(5).fill(200_000n));
  const [channel] = [...server.channels.values()];
  // The channel's balance covered every voucher; each top-up was within the ceiling.
  expect(channel!.charged).toBe(1_000_000n);
  expect(channel!.balance).toBeGreaterThanOrEqual(1_000_000n);
  expect(server.deposits).toBeGreaterThan(1);
});

it('stops a batch at the daily budget: the call that would pass it signs nothing', async () => {
  dir = await mkdtemp(join(tmpdir(), 'model-route-batch-budget-'));
  const server = new FakeRouter({ path: '/api/model-router/route', amount: '200000' });
  const transport = routingTransport(server, { sessionBudgetAtomic: 450_000n });
  const settled = await Promise.allSettled(
    [1, 2, 3].map(() => transport.route({ schemaVersion: 1 })),
  );
  expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(server.paidRequests()).toBe(1);
  expect([...server.channels.values()][0]!.balance).toBeLessThanOrEqual(450_000n);
});
