import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createUniqueFile,
  maskDeep,
  MAX_SENT_CHARS,
  mediaUrlsIn,
  pinnedLookup,
  reconcilePayments,
  recordedSent,
  saveMedia,
  type MediaTransport,
} from './paid';
import { runPaymentsReconcile } from './payments';
import { readSpendSummary } from '../lib/spend-ledger';
import { createLocalSpendAuthorizer, releaseUnchargedExposure } from '../lib/wallet/spend';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-paid-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PUBLIC = { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] };

describe('what the ledger records as sent', () => {
  it('masks a secret, then cuts to 4 KB', () => {
    const secret = `sk-ant-api03-${'a'.repeat(90)}`;
    const sent = recordedSent(`use ${secret} ${'x'.repeat(10_000)}`);
    expect(sent).not.toContain(secret);
    expect(sent).toHaveLength(MAX_SENT_CHARS);
  });
});

describe('masking a JSON input', () => {
  it('masks each key and string leaf on its own, whatever precedes it', () => {
    const key = `sk-ant-api03-${'a'.repeat(90)}`;
    const masked = JSON.stringify(
      maskDeep({ text: `\n${key}`, list: [`\tghp_${'c'.repeat(36)}`], [`\n${key}`]: 1, n: 2 }),
    );
    expect(masked).not.toContain(key);
    expect(masked).not.toContain('ghp_ccc');
    expect(masked).toContain('"n":2');
    // The serialized form alone hides both: the escape's letter joins the key.
    expect(recordedSent(JSON.stringify({ text: `\n${key}` }))).toContain(key);
  });
});

describe('the media a paid result links to', () => {
  it('finds https media links by extension, once each, at most five', () => {
    const body = JSON.stringify({
      a: 'https://cdn.test/a.PNG',
      b: 'https://cdn.test/a.PNG',
      c: 'http://cdn.test/plain.mp3',
      d: 'https://cdn.test/page.html',
      e: 'https://cdn.test/v.mp4?sig=1',
      f: [
        'https://c.test/1.wav',
        'https://c.test/2.ogg',
        'https://c.test/3.gif',
        'https://c.test/4.mov',
      ],
    });
    expect(mediaUrlsIn(body)).toEqual([
      'https://cdn.test/a.PNG',
      'https://cdn.test/v.mp4?sig=1',
      'https://c.test/1.wav',
      'https://c.test/2.ogg',
      'https://c.test/3.gif',
    ]);
  });

  /** A scripted transport: what each hop was asked to connect to. */
  function transport(
    answer: (url: string) => { status: number; location?: string; body?: Uint8Array },
  ): { transport: MediaTransport; hops: { url: string; address: string }[] } {
    const hops: { url: string; address: string }[] = [];
    return {
      hops,
      transport: async (target) => {
        hops.push({ url: target.url.toString(), address: target.address });
        const { status, location, body } = answer(target.url.toString());
        const bytes = body ?? new Uint8Array();
        return {
          status,
          ...(location !== undefined ? { location } : {}),
          body: (async function* () {
            yield bytes;
          })(),
          discard: () => undefined,
        };
      },
    };
  }

  it('connects each hop to the address it validated, and caps the size', async () => {
    const answers: Record<string, string> = {
      'cdn.test': '93.184.216.34',
      'files.test': '93.184.216.35',
    };
    const destination = {
      resolveHostname: async (name: string) => [{ address: answers[name]!, family: 4 }],
    };
    const { transport: t, hops } = transport((url) =>
      url.endsWith('/start.png')
        ? { status: 302, location: 'https://files.test/real.png' }
        : url.endsWith('/big.png')
          ? { status: 200, body: new Uint8Array(64) }
          : { status: 200, body: new Uint8Array([1, 2, 3]) },
    );
    const saved = await saveMedia(
      dir,
      'cap',
      ['https://cdn.test/start.png', 'https://cdn.test/big.png'],
      { transport: t, destination, now: () => 7, maxBytes: 16 },
    );
    expect(hops).toEqual([
      { url: 'https://cdn.test/start.png', address: '93.184.216.34' },
      { url: 'https://files.test/real.png', address: '93.184.216.35' },
      { url: 'https://cdn.test/big.png', address: '93.184.216.34' },
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(/[/\\]downloads[/\\]cap-1-7-[0-9a-f]{8}\.png$/);
    expect(new Uint8Array(await readFile(saved[0]!))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('refuses a redirect to a private address, and never connects to it', async () => {
    const { transport: t, hops } = transport(() => ({
      status: 302,
      location: 'https://127.0.0.1/a.png',
    }));
    const saved = await saveMedia(dir, 'cap', ['https://cdn.test/a.png'], {
      transport: t,
      destination: PUBLIC,
    });
    expect(saved).toEqual([]);
    expect(hops.map((h) => h.url)).toEqual(['https://cdn.test/a.png']);
  });

  /** DNS REBINDING: the socket's lookup answers the validated address, not a
   *  fresh resolution of the name. */
  it('pins the connection: the lookup answers only the validated address', () => {
    const lookup = pinnedLookup({ address: '93.184.216.34', family: 4 });
    const one: unknown[] = [];
    (lookup as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void)(
      'rebinding.test',
      {},
      (...args) => one.push(args),
    );
    const all: unknown[] = [];
    (lookup as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void)(
      'rebinding.test',
      { all: true },
      (...args) => all.push(args),
    );
    expect(one).toEqual([[null, '93.184.216.34', 4]]);
    expect(all).toEqual([[null, [{ address: '93.184.216.34', family: 4 }]]]);
  });

  /** Two lookups saving in the same millisecond each get their own file. */
  it('never gives two saves the same file', async () => {
    const { transport: t } = transport(() => ({ status: 200, body: new Uint8Array([9]) }));
    const both = await Promise.all(
      [1, 2].map(() =>
        saveMedia(dir, 'same', ['https://cdn.test/a.png'], {
          transport: t,
          destination: PUBLIC,
          now: () => 7,
        }),
      ),
    );
    const paths = both.flat();
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    const a = await createUniqueFile(join(dir, 'x'), 'stem', 'bin');
    const b = await createUniqueFile(join(dir, 'x'), 'stem', 'bin');
    await a.handle.close();
    await b.handle.close();
    expect(a.path).not.toBe(b.path);
  });
});

describe('resolving a settlement left unknown', () => {
  const RPC = 'https://rpc.example.test';
  const FROM = `0x${'1'.repeat(40)}`;
  const nonce = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
  const NOW = 1_800_000_000_000;
  const past = String(NOW / 1000 - 60);
  const future = String(NOW / 1000 + 60);

  function record(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 1,
      ts: '2027-01-15T00:00:00.000Z',
      capabilityId: `cap-${n}`,
      provider: 'Seller',
      url: 'https://seller.test/x',
      sent: 'q',
      amountAtomic: '10000',
      settlement: 'unknown',
      savedFiles: [],
      authorization: { from: FROM, nonce: nonce(n), validBefore: past },
      ...over,
    };
  }

  async function ledger(lines: string[]): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(dir, 'paid'), { recursive: true });
    await writeFile(join(dir, 'paid', 'ledger.jsonl'), lines.map((l) => `${l}\n`).join(''));
  }

  /** An RPC that says nonces in `used` were spent; records every call. */
  function rpc(used: Set<string>, calls: string[] = []): typeof fetch {
    return (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const data = (JSON.parse(String(init?.body)) as { params: [{ data: string; to: string }] })
        .params[0].data;
      calls.push(data);
      const spent = used.has(`0x${data.slice(-64)}`);
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: `0x${(spent ? 1 : 0).toString(16).padStart(64, '0')}`,
        }),
      );
    }) as typeof fetch;
  }

  async function read(): Promise<Record<string, unknown>[]> {
    return (await readFile(join(dir, 'paid', 'ledger.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return { raw: line };
        }
      });
  }

  it('marks a used authorization charged and an unused one not, and leaves the rest', async () => {
    await ledger([
      JSON.stringify(record(1)),
      JSON.stringify(record(2)),
      JSON.stringify(
        record(3, { authorization: { from: FROM, nonce: nonce(3), validBefore: future } }),
      ),
      JSON.stringify(record(4, { settlement: 'settled', txHash: `0x${'a'.repeat(64)}` })),
      JSON.stringify(record(5, { authorization: undefined })),
      'not json',
    ]);
    const calls: string[] = [];
    const outcome = await reconcilePayments(dir, {
      rpcUrl: RPC,
      fetchImpl: rpc(new Set([nonce(1)]), calls),
      now: () => NOW,
    });
    expect(outcome).toEqual({
      checked: 2,
      settled: 1,
      notCharged: 1,
      unknown: 2,
      releasedAtomic: '0',
    });
    // authorizationState(from, nonce): the selector, the padded address, the nonce.
    expect(calls[0]).toBe(`0xe94a0102${'1'.repeat(40).padStart(64, '0')}${nonce(1).slice(2)}`);
    const after = await read();
    expect(after.map((r) => r.settlement ?? r.raw)).toEqual([
      'settled',
      'not_charged',
      'unknown',
      'settled',
      'unknown',
      'not json',
    ]);
    expect(after[0]!.reconciledAt).toBe(new Date(NOW).toISOString());
  });

  it('asks about at most three per pass, and keeps an unanswered one unknown', async () => {
    await ledger([1, 2, 3, 4, 5].map((n) => JSON.stringify(record(n))));
    const calls: string[] = [];
    const outcome = await reconcilePayments(dir, {
      rpcUrl: RPC,
      fetchImpl: rpc(new Set(), calls),
      now: () => NOW,
    });
    expect(calls).toHaveLength(3);
    expect(outcome).toMatchObject({ checked: 3, notCharged: 3, unknown: 2 });

    const failing = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    const second = await reconcilePayments(dir, {
      rpcUrl: RPC,
      fetchImpl: failing,
      now: () => NOW,
    });
    expect(second).toEqual({
      checked: 2,
      settled: 0,
      notCharged: 0,
      unknown: 2,
      releasedAtomic: '0',
    });
    expect((await read()).map((r) => r.settlement)).toEqual([
      'not_charged',
      'not_charged',
      'not_charged',
      'unknown',
      'unknown',
    ]);
  });

  it('reads nothing from the chain with no ledger at all', async () => {
    const calls: string[] = [];
    const outcome = await reconcilePayments(dir, { rpcUrl: RPC, fetchImpl: rpc(new Set(), calls) });
    expect(outcome).toEqual({
      checked: 0,
      settled: 0,
      notCharged: 0,
      unknown: 0,
      releasedAtomic: '0',
    });
    expect(calls).toHaveLength(0);
  });

  /** NOT CHARGED GIVES THE BUDGET BACK: exactly that payment's exposure, once. */
  it("lowers today's committed spend by a not-charged payment's amount", async () => {
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: {
        maxAutoSpendAtomic: 1_000_000n,
        sessionBudgetAtomic: 5_000_000n,
        allowlistCreators: [],
      },
      now: () => NOW - 120_000,
    });
    for (const [n, amount] of [
      [1, 30_000n],
      [2, 50_000n],
    ] as const) {
      const authz = await auth.authorize({ amountAtomic: amount, creator: 'seller.test' });
      await auth.commit(authz.reservationId, amount, { mode: 'automatic', nonce: nonce(n) });
    }
    const before = await readSpendSummary(dir, { now: () => NOW });
    expect(before?.committedAtomic).toBe('80000');
    await ledger([
      JSON.stringify(record(1, { amountAtomic: '30000' })),
      JSON.stringify(record(2, { amountAtomic: '50000' })),
    ]);
    const outcome = await reconcilePayments(dir, {
      rpcUrl: RPC,
      fetchImpl: rpc(new Set([nonce(1)])),
      now: () => NOW,
    });
    expect(outcome).toMatchObject({ settled: 1, notCharged: 1, releasedAtomic: '50000' });
    const after = await readSpendSummary(dir, { now: () => NOW });
    expect(after?.committedAtomic).toBe('30000');
    expect(after?.automaticCommittedAtomic).toBe('30000');
    // Once: the nonce's exposure is gone, so a second release finds nothing.
    expect(await releaseUnchargedExposure(dir, nonce(2), { now: () => NOW })).toBe(0n);
  });

  /** RELEASE FIRST, THEN MARK: a release that cannot be written leaves the
   *  record unknown, and the next pass gives the budget back and marks it. */
  it('keeps a record unknown until its spend release succeeds', async () => {
    const { chmod } = await import('node:fs/promises');
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: {
        maxAutoSpendAtomic: 1_000_000n,
        sessionBudgetAtomic: 5_000_000n,
        allowlistCreators: [],
      },
      now: () => NOW - 120_000,
    });
    const authz = await auth.authorize({ amountAtomic: 50_000n, creator: 'seller.test' });
    await auth.commit(authz.reservationId, 50_000n, { mode: 'automatic', nonce: nonce(2) });
    await ledger([JSON.stringify(record(2, { amountAtomic: '50000' }))]);
    // The spend ledger's directory refuses the lock, so the release cannot run.
    await chmod(dir, 0o500);
    let first;
    try {
      first = await reconcilePayments(dir, {
        rpcUrl: RPC,
        fetchImpl: rpc(new Set()),
        now: () => NOW,
      });
    } finally {
      await chmod(dir, 0o700);
    }
    expect(first).toMatchObject({ checked: 1, notCharged: 0, unknown: 1, releasedAtomic: '0' });
    expect((await read())[0]!.settlement).toBe('unknown');
    expect((await readSpendSummary(dir, { now: () => NOW }))?.committedAtomic).toBe('50000');

    const second = await reconcilePayments(dir, {
      rpcUrl: RPC,
      fetchImpl: rpc(new Set()),
      now: () => NOW,
    });
    expect(second).toMatchObject({ notCharged: 1, releasedAtomic: '50000' });
    expect((await read())[0]!.settlement).toBe('not_charged');
    expect((await readSpendSummary(dir, { now: () => NOW }))?.committedAtomic).toBe('0');
  });

  it('releases nothing from a spend ledger an older build wrote', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const legacy = {
      schemaVersion: 2,
      windowStartMs: NOW - 60_000,
      committedAtomic: '50000',
      reservations: [],
    };
    await writeFile(join(dir, 'spend.json'), JSON.stringify(legacy));
    await ledger([JSON.stringify(record(2, { amountAtomic: '50000' }))]);
    const outcome = await reconcilePayments(dir, {
      rpcUrl: RPC,
      fetchImpl: rpc(new Set()),
      now: () => NOW,
    });
    expect(outcome).toMatchObject({ notCharged: 1, releasedAtomic: '0' });
    expect((await readSpendSummary(dir, { now: () => NOW }))?.committedAtomic).toBe('50000');
  });

  it('is what `tenjin payments reconcile` runs, past the per-lookup three', async () => {
    await ledger([1, 2, 3, 4].map((n) => JSON.stringify(record(n))));
    const sink = { write: () => true } as unknown as NodeJS.WritableStream;
    const result = await runPaymentsReconcile(
      {
        flags: { json: true, timeout: 5000 },
        dataDir: dir,
        io: { stdout: sink, stderr: sink, isTTY: false },
      },
      { fetchImpl: rpc(new Set([nonce(4)])), now: () => NOW },
    );
    expect(result.data).toMatchObject({ checked: 4, settled: 1, notCharged: 3, unknown: 0 });
    expect(result.humanLines?.[0]).toBe('Checked 4: 1 charged, 3 not charged.');
  });
});
