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
  RECHECK_MS,
  reconcilePayments,
  recordedSent,
  saveMedia,
  writeAll,
  type MediaTransport,
} from './paid';
import { runPaymentsList, runPaymentsReconcile } from './payments';
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

describe('writing a saved file', () => {
  /** A handle that writes at most three bytes a call, as a short write may. */
  function shortHandle() {
    const written: number[] = [];
    return {
      written,
      handle: {
        write: async (buffer: Uint8Array, offset = 0, length = buffer.byteLength) => {
          const take = Math.min(3, length);
          written.push(...buffer.subarray(offset, offset + take));
          return { bytesWritten: take, buffer };
        },
      },
    };
  }

  it('keeps writing after a short write until every byte is down', async () => {
    const { handle, written } = shortHandle();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await writeAll(handle as never, bytes);
    expect(written).toEqual([...bytes]);
  });

  it('throws on a write that makes no progress, rather than spinning', async () => {
    const stuck = { write: async (buffer: Uint8Array) => ({ bytesWritten: 0, buffer }) };
    await expect(writeAll(stuck as never, new Uint8Array([1]))).rejects.toThrow('no progress');
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
    const { saved } = await saveMedia(
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
    const { saved } = await saveMedia(dir, 'cap', ['https://cdn.test/a.png'], {
      transport: t,
      destination: PUBLIC,
    });
    expect(saved).toEqual([]);
    expect(hops.map((h) => h.url)).toEqual(['https://cdn.test/a.png']);
  });

  /** A FAILURE A LATER TRY COULD GET PAST (the network, a 5xx, a 429) is
   *  `failed`; a refusal of ours (a private address, the size cap) or a link
   *  that is gone (a 404) is not. */
  it('reports a download a later try could save as failed', async () => {
    const save = (t: MediaTransport, opts: { maxBytes?: number } = {}) =>
      saveMedia(dir, 'try', ['https://cdn.test/a.png'], {
        transport: t,
        destination: PUBLIC,
        ...opts,
      });
    const down: MediaTransport = async () => {
      throw new Error('socket hang up');
    };
    expect(await save(down)).toEqual({ saved: [], capped: false, failed: true });
    for (const status of [503, 429]) {
      expect(await save(transport(() => ({ status })).transport)).toMatchObject({ failed: true });
    }
    expect(await save(transport(() => ({ status: 404 })).transport)).toMatchObject({
      failed: false,
    });
    const big = transport(() => ({ status: 200, body: new Uint8Array(64) })).transport;
    expect(await save(big, { maxBytes: 16 })).toMatchObject({ failed: false });
    const away = transport(() => ({ status: 302, location: 'https://127.0.0.1/a.png' }));
    expect(await save(away.transport)).toMatchObject({ failed: false });
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

  /** THE CALL'S CAP COUNTS WHAT WAS WRITTEN: a download still in flight holds
   *  only its own bytes, so a file beside it is saved while the real total is
   *  under the cap, and none is written past it. */
  it("saves side by side up to the call's cap, and never past it", async () => {
    const file = new Uint8Array(8);
    // The first download answers once the second has started, or after a
    // moment: side by side, the first must not hold the second's room.
    let started = 0;
    let bothIn!: () => void;
    const gate = new Promise<void>((resolve) => {
      bothIn = resolve;
    });
    const gated: MediaTransport = async () => {
      started += 1;
      if (started === 2) bothIn();
      else await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 200))]);
      return {
        status: 200,
        body: (async function* () {
          yield file;
        })(),
        discard: () => undefined,
      };
    };
    const budget = { leftBytes: 20 };
    const both = await Promise.all(
      ['https://cdn.test/a.png', 'https://cdn.test/b.png'].map((url) =>
        saveMedia(dir, 'room', [url], { transport: gated, destination: PUBLIC, budget }),
      ),
    );
    expect(both.map(({ saved, capped }) => [saved.length, capped])).toEqual([
      [1, false],
      [1, false],
    ]);
    expect(budget.leftBytes).toBe(4);
    // 16 written of 20: a third 8-byte file would pass the cap, so it is not
    // kept, its bytes go back, and the call says it ran out of room.
    const third = await saveMedia(dir, 'room', ['https://cdn.test/c.png'], {
      transport: gated,
      destination: PUBLIC,
      budget,
    });
    expect(third).toEqual({ saved: [], capped: true, failed: false });
    expect(budget.leftBytes).toBe(4);
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
    const paths = both.flatMap(({ saved }) => saved);
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
  /** An RPC that says nonces in `used` were spent, with its latest block at
   *  `chainNow` (ms); records every eth_call and the block it was read at. */
  function rpc(
    used: Set<string>,
    calls: string[] = [],
    chain: { chainNow?: number; tags?: string[] } = {},
  ): typeof fetch {
    return (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: [{ data: string }, string];
      };
      if (body.method === 'eth_getBlockByNumber') {
        const seconds = Math.floor((chain.chainNow ?? NOW) / 1000);
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { number: '0x2a', timestamp: `0x${seconds.toString(16)}` },
          }),
        );
      }
      const data = body.params[0].data;
      calls.push(data);
      chain.tags?.push(body.params[1]);
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

  /** THE CHAIN'S CLOCK DECIDES. This machine's clock running ahead, or a
   *  node lagging behind, leaves a record unknown until the chain's own
   *  latest block is past validBefore; the state is then read at that block. */
  it("asks only once the chain's latest block is past validBefore, and reads at it", async () => {
    await ledger([JSON.stringify(record(1))]);
    const calls: string[] = [];
    const lagging = await reconcilePayments(dir, {
      rpcUrl: RPC,
      fetchImpl: rpc(new Set(), calls, { chainNow: NOW - 120_000 }),
      now: () => NOW,
    });
    expect(lagging).toMatchObject({ checked: 0, unknown: 1 });
    expect(calls).toHaveLength(0);
    expect((await read())[0]!.lastCheckedAt).toBeUndefined();
    const tags: string[] = [];
    const caughtUp = await reconcilePayments(dir, {
      rpcUrl: RPC,
      fetchImpl: rpc(new Set(), calls, { tags }),
      now: () => NOW,
    });
    expect(caughtUp).toMatchObject({ checked: 1, notCharged: 1 });
    expect(tags).toEqual(['0x2a']);
  });

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
    // BACKOFF: the two the RPC could not answer for are stamped, and the
    // lookup-time pass leaves them alone until RECHECK_MS has passed.
    expect((await read())[3]!.lastCheckedAt).toBe(new Date(NOW).toISOString());
    const recheckCalls: string[] = [];
    const soon = await reconcilePayments(dir, {
      rpcUrl: RPC,
      fetchImpl: rpc(new Set(), recheckCalls),
      now: () => NOW + 60_000,
    });
    expect(soon.checked).toBe(0);
    expect(recheckCalls).toHaveLength(0);
    const later = await reconcilePayments(dir, {
      rpcUrl: RPC,
      fetchImpl: rpc(new Set(), recheckCalls),
      now: () => NOW + RECHECK_MS,
    });
    expect(later.checked).toBe(2);
    // The command asks about every due record, however recent its last check.
    const byHand = await reconcilePayments(dir, {
      rpcUrl: RPC,
      fetchImpl: rpc(new Set()),
      now: () => NOW + RECHECK_MS,
      recheckMs: 0,
    });
    expect(byHand).toMatchObject({ checked: 0, unknown: 0 });
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
      now: () => NOW + RECHECK_MS,
    });
    expect(second).toMatchObject({ notCharged: 1, releasedAtomic: '50000' });
    expect((await read())[0]!.settlement).toBe('not_charged');
    expect((await readSpendSummary(dir, { now: () => NOW + RECHECK_MS }))?.committedAtomic).toBe(
      '0',
    );
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

  it('is what a bare `tenjin payments` lists: newest first, the tx where it settled', async () => {
    const tx = `0x${'a'.repeat(64)}`;
    await ledger([
      JSON.stringify(
        record(1, { ts: '2027-01-15T09:30:00.000Z', settlement: 'settled', txHash: tx }),
      ),
      'not a record',
      JSON.stringify(record(2, { ts: '2027-01-15T10:45:00.000Z', amountAtomic: '3000' })),
    ]);
    const sink = { write: () => true } as unknown as NodeJS.WritableStream;
    const result = await runPaymentsList({
      flags: { json: false, timeout: 5000 },
      dataDir: dir,
      io: { stdout: sink, stderr: sink, isTTY: true },
    });
    expect(result.data).toEqual({
      ledger: join(dir, 'paid', 'ledger.jsonl'),
      total: 2,
      payments: [
        {
          at: '2027-01-15T10:45:00.000Z',
          provider: 'Seller',
          service: 'cap-2',
          amount: { atomic: '3000', usd: '0.003' },
          settlement: 'unknown',
        },
        {
          at: '2027-01-15T09:30:00.000Z',
          provider: 'Seller',
          service: 'cap-1',
          amount: { atomic: '10000', usd: '0.01' },
          settlement: 'settled',
          txHash: tx,
        },
      ],
    });
    expect(result.humanLines).toEqual([
      'TIME (UTC)        PROVIDER  SERVICE  AMOUNT  STATUS   TX',
      '2027-01-15 10:45  Seller    cap-2    $0.003  unknown',
      `2027-01-15 09:30  Seller    cap-1    $0.01   settled  ${tx}`,
      `From ${join(dir, 'paid', 'ledger.jsonl')}.`,
      '1 with settlement unknown: `tenjin payments reconcile` asks the chain once they expire.',
    ]);
  });

  it('says so when this machine has paid for nothing', async () => {
    const sink = { write: () => true } as unknown as NodeJS.WritableStream;
    const result = await runPaymentsList({
      flags: { json: true, timeout: 5000 },
      dataDir: dir,
      io: { stdout: sink, stderr: sink, isTTY: false },
    });
    expect(result.data).toMatchObject({ total: 0, payments: [] });
    expect(result.humanLines).toEqual(['No paid lookups on this machine yet.']);
  });
});
