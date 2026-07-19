import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLookup } from './commands/lookup';
import { runInspect } from './commands/inspect';
import { runBuy } from './commands/buy';
import { runOutcome } from './commands/outcome';
import type { CommandContext } from './context';
import type { Io } from './lib/output';

/**
 * Live end-to-end lane (acceptance item 45): drives the real commands against a
 * REAL deployment over the network. Off by default (unit tests never touch the
 * network); opt in with TENJIN_E2E_BASE_URL, e.g. a local dev server
 * (http://localhost:3000) or a preview deploy. The paid leg additionally needs
 * TENJIN_E2E_WALLET_KEY (a funded throwaway key) AND TENJIN_E2E_PAID_REF (the
 * resource to buy) because it settles real USDC; without them it verifies the
 * free hit, the 402 decode, and the lookup/outcome loop, which is the
 * wallet-free half of the first-run proof.
 */
const BASE = process.env.TENJIN_E2E_BASE_URL;
const PAID_KEY = process.env.TENJIN_E2E_WALLET_KEY;
const PAID_REF = process.env.TENJIN_E2E_PAID_REF;

function sinkIo(): Io {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  return { stdout: sink, stderr: sink, isTTY: false };
}

describe.skipIf(BASE === undefined)('live e2e (TENJIN_E2E_BASE_URL)', () => {
  let dataDir: string;
  let ctx: CommandContext;

  beforeEach(async () => {
    dataDir = join(await mkdtemp(join(tmpdir(), 'tenjin-e2e-')), '.tenjin');
    ctx = {
      flags: { json: true, timeout: 15000, baseUrl: BASE as string },
      dataDir,
      io: sinkIo(),
    };
  });
  afterEach(async () => {
    await rm(join(dataDir, '..'), { recursive: true, force: true });
  });

  it('lookup answers CANDIDATES or an honest MISS and outcome gets a 202', async () => {
    const lookup = await runLookup({ question: 'How do x402 payments settle on Base?' }, ctx);
    const data = lookup.data as { decision: string; lookupId: string };
    expect(['CANDIDATES', 'MISS']).toContain(data.decision);
    const outcome = await runOutcome({ last: true, status: 'regenerated' }, ctx);
    expect((outcome.data as { accepted: boolean }).accepted).toBe(true);
  });

  it('a free article is buyable without any wallet and lands in the library', async () => {
    // Find a free published article via the public listing.
    const listing = (await fetch(`${BASE}/api/articles?limit=50`).then((r) => r.json())) as {
      items: Array<{ price: string; slug: string; creator: { handle: string | null } }>;
    };
    const free = listing.items.find((a) => a.price === '0' && a.creator.handle !== null);
    if (free === undefined) return; // Deployment has no free post; nothing to prove here.
    const res = await runBuy({ ref: `${free.creator.handle as string}/${free.slug}` }, ctx);
    const data = res.data as { path: string; paid: { atomic: string }; entitlement: string };
    expect(data.entitlement).toBe('free');
    expect(data.paid.atomic).toBe('0');
    expect(readFileSync(data.path, 'utf8').length).toBeGreaterThan(0);
  });

  it('a paid article inspects to a decoded 402 challenge and never pays', async () => {
    const listing = (await fetch(`${BASE}/api/articles?limit=50`).then((r) => r.json())) as {
      items: Array<{ price: string; slug: string; creator: { handle: string | null } }>;
    };
    const paid = listing.items.find((a) => a.price !== '0' && a.creator.handle !== null);
    if (paid === undefined) return;
    const res = await runInspect({ ref: `${paid.creator.handle as string}/${paid.slug}` }, ctx);
    const data = res.data as { access: string; price: { atomic: string }; network: string };
    expect(data.access).toBe('paid');
    expect(data.price.atomic).toBe(paid.price);
    expect(data.network).toMatch(/^eip155:/);
  });

  it.skipIf(PAID_KEY === undefined || PAID_REF === undefined)(
    'buys a paid resource end to end, then re-reads it free (settles real USDC)',
    async () => {
      process.env.TENJIN_WALLET_KEY = PAID_KEY as string;
      try {
        const first = await runBuy({ ref: PAID_REF as string, yes: true }, ctx);
        const data = first.data as { entitlement: string; txHash: string | null };
        // A rerun against an already-owning wallet is the entitled path; a fresh
        // wallet settles and carries the tx hash.
        if (data.entitlement === 'paid') {
          expect(data.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
        } else {
          expect(data.entitlement).toBe('already-entitled');
        }
        const again = await runBuy({ ref: PAID_REF as string, yes: true }, ctx);
        expect((again.data as { entitlement: string }).entitlement).toBe('already-entitled');
        expect((again.data as { txHash: string | null }).txHash).toBeNull();
      } finally {
        delete process.env.TENJIN_WALLET_KEY;
      }
    },
  );
});
