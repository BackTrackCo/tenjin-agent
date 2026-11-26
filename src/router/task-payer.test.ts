import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { httpRequest } from '../lib/http';
import { FEE_ABOVE_CEILING } from './fee';
import { FakeRouter, payerDeps } from './fee-test-utils';
import { ROUTE_PAID_PATH, RouteSkipped } from './decision';
import { RoutingPayer } from './routing-payer';

/**
 * THE APPROVED FEE BINDS THE REAL PAYER. A task run is quoted a fee, and the
 * payer is narrowed to it: a live 402 above it is not signed, whatever the
 * tool router's own ceiling allows. These tests drive the real `RoutingPayer`
 * against a stub router, not a stub of the payer.
 */

const BASE = 'https://router.test';
const wallet = privateKeyToAccount(generatePrivateKey());

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-task-payer-'));
  await mkdir(join(dir, '.git'));
  await writeFile(join(dir, 'config.json'), JSON.stringify({ maxAutoSpend: '250000' }));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function send(route: ReturnType<RoutingPayer['routeFor']>, fake: FakeRouter) {
  return route.send(`${BASE}${ROUTE_PAID_PATH}`, {
    method: 'POST',
    timeoutMs: 5000,
    jsonBody: { schemaVersion: 1, task: 'x', run: 'r' },
    fetchImpl: fake.fetch,
  } as Parameters<typeof httpRequest>[1]);
}

describe('the fee a task run was approved for', () => {
  it('is not signed when the live 402 is above it', async () => {
    const fake = new FakeRouter({ amount: '1500' });
    const payer = new RoutingPayer(payerDeps(fake, dir, wallet));
    const route = payer.routeFor(BASE, 750n);
    const refused = await send(route, fake).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(RouteSkipped);
    expect((refused as RouteSkipped).why).toBe(FEE_ABOVE_CEILING);
    expect(fake.settledFees).toBe(0);
    expect(fake.deposits).toBe(0);
    await payer.idle();
  });

  it('is paid when the live 402 is at it', async () => {
    const fake = new FakeRouter({ amount: '750' });
    const payer = new RoutingPayer(payerDeps(fake, dir, wallet));
    const response = await send(payer.routeFor(BASE, 750n), fake);
    expect(response.ok).toBe(true);
    expect(fake.settledFees).toBe(1);
    await payer.idle();
  });

  it('keeps the tool router ceiling for a call with no approved fee', async () => {
    const fake = new FakeRouter({ amount: '1500' });
    const payer = new RoutingPayer(payerDeps(fake, dir, wallet));
    const response = await send(payer.routeFor(BASE), fake);
    expect(response.ok).toBe(true);
    expect(fake.settledFees).toBe(1);
    await payer.idle();
  });
});
