import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rememberingBalanceReader } from '../lib/usdc-balance';
import { WalletRecordSchema } from '../lib/wallet/store';
import { createLocalSpendAuthorizer } from '../lib/wallet/spend';
import type { OfferSpec } from './decision';
import { markHeld, markRouted } from './held';
import { WALLET_CREATED_FILE, writeWalletCreated } from './mod-state';
import { appendPaidRecord } from './paid';
import { claimSpecPayment, settleSpecPayment, storeSpecs } from './specs';

/**
 * THE FILES THE MOD READS, written by the CLI's own writers, with the fields
 * and version the mod checks before it reads them (`register.tsx`). A rename
 * or a version bump here fails this test before the mod silently says less.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-mod-state-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ID = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d77';
const ADDRESS = '0x3c0D84055994c3062819Ce8730869D0aDeA4c3Bf';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const json = async (path: string) =>
  JSON.parse(await readFile(join(dir, path), 'utf8')) as Record<string, unknown>;

describe('the state contract between the CLI and the mod', () => {
  it('keeps a spec under the SHA-256 of its offer id, with the price fields the row shows', async () => {
    const spec: OfferSpec = {
      id: ID,
      capabilityId: 'exa-search',
      provider: 'Exa',
      description: 'web search',
      priceAtomic: '7000',
      priceVaries: false,
      maxAmountAtomic: '7000',
      payTo: '0x1111111111111111111111111111111111111111',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      request: { method: 'GET', url: 'https://api.exa.ai/search', fields: {}, location: 'query' },
      input: {},
      pinned: {},
    };
    await storeSpecs(dir, [spec]);
    expect(await json(`progress/specs/${sha256(ID)}.json`)).toMatchObject({
      capabilityId: 'exa-search',
      priceAtomic: '7000',
      maxAmountAtomic: '7000',
      priceVaries: false,
    });
  });

  it("records the spec's payment beside it, by state", async () => {
    await claimSpecPayment(dir, ID);
    await settleSpecPayment(dir, ID, { amountAtomic: 7000n, txHash: '0xab', signed: true });
    const paid = await json(`progress/specs/${sha256(ID)}.paid.json`);
    expect(paid).toMatchObject({ state: 'paid', amountAtomic: '7000', txHash: '0xab' });
    expect(typeof paid.at).toBe('string');
  });

  it('appends version 1 rows to the paid ledger', async () => {
    await appendPaidRecord(dir, {
      version: 1,
      ts: new Date().toISOString(),
      capabilityId: 'exa-search',
      provider: 'Exa',
      url: 'https://api.exa.ai/search',
      sent: '{}',
      amountAtomic: '7000',
      txHash: '0xab',
      settlement: 'settled',
      savedFiles: [],
    });
    const [line] = (await readFile(join(dir, 'paid', 'ledger.jsonl'), 'utf8')).trim().split('\n');
    expect(JSON.parse(line!)).toMatchObject({
      version: 1,
      capabilityId: 'exa-search',
      amountAtomic: '7000',
      txHash: '0xab',
      settlement: 'settled',
    });
  });

  it("keeps today's automatic spend in schema 2 of the spend ledger", async () => {
    const authorizer = createLocalSpendAuthorizer({
      dir,
      policy: { maxAutoSpendAtomic: 250_000n, sessionBudgetAtomic: null, allowlistCreators: [] },
    });
    await authorizer.commit(undefined, 7000n);
    const spend = await json('spend.json');
    expect(spend).toMatchObject({ schemaVersion: 2, automaticCommittedAtomic: '7000' });
    expect(typeof spend.windowStartMs).toBe('number');
    expect(Array.isArray(spend.reservations)).toBe(true);
  });

  it('remembers the balance as version 1, keyed by the lowercased address', async () => {
    const read = rememberingBalanceReader(dir, { read: async () => 0n, now: () => 1 });
    await read(ADDRESS, 'https://rpc.example.test', { timeoutMs: 1000 });
    expect(await json('balance.json')).toEqual({
      version: 1,
      address: ADDRESS.toLowerCase(),
      atomic: '0',
      at: 1,
    });
  });

  it('keeps the wallet address top-level, readable without the passphrase', () => {
    expect(Object.keys(WalletRecordSchema.shape)).toContain('address');
  });

  it('keeps a held native call under the SHA-256 of its tool_use_id, and marks it routed', async () => {
    await markHeld(dir, 'toolu_held', { offerId: ID, label: 'Exa search', priceAtomic: '7000' }, 1);
    const path = `progress/held/${sha256('toolu_held')}.json`;
    expect(await json(path)).toEqual({
      version: 1,
      at: 1,
      outcome: 'held',
      label: 'Exa search',
      priceAtomic: '7000',
      offerId: ID,
    });
    await markRouted(dir, ID, 2);
    expect(await json(path)).toMatchObject({ version: 1, outcome: 'routed', offerId: ID });
  });

  it('marks a wallet the install created in this run', async () => {
    await writeWalletCreated(dir, ADDRESS, Date.parse('2026-10-15T00:00:00Z'));
    expect(await json(WALLET_CREATED_FILE)).toEqual({
      version: 1,
      address: ADDRESS,
      at: '2026-10-15T00:00:00.000Z',
    });
  });
});
