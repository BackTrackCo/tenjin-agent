import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { buildExactPayment } from '../../lib/x402-pay';
import { testSigner } from '../../lib/read-test-utils';
import {
  executePaidRequest,
  isPublicAddress,
  assertRequestSafe,
  safeHttpsTransport,
  validateNestedTargets,
  type AutoPolicy,
  type AutoHttpResponse,
  type ExecutionDeps,
  type PaidRequestInput,
} from './execution';

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));
vi.mock('node:https', () => ({ request: network.request }));

const endpoint = 'https://vendor.example/search';
const quote: PaymentRequired = {
  x402Version: 2,
  resource: { url: endpoint, description: 'Search', mimeType: 'application/json' },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '7000',
      payTo: '0x1111111111111111111111111111111111111111',
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
};
const input: PaidRequestInput = {
  request: {
    url: endpoint,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"query":"router"}',
  },
  identity: {
    sessionId: 'session',
    requestId: 'tool-1',
    stepId: 'search',
    contractHash: 'contract',
    contextHash: 'context',
  },
  operation: 'search',
  advertisedAccepts: quote.accepts,
};
const initialPolicy: AutoPolicy = {
  runId: 'demo',
  revision: '1',
  authorization: 'auto',
  expiresAtMs: 20_000,
  maxCallAtomic: '100000',
  maxRunAtomic: '1000000',
  allowedOperations: ['search', 'fetch'],
};
function challenge(value: PaymentRequired = quote): AutoHttpResponse {
  return {
    status: 402,
    headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(value) },
    body: '{}',
  };
}
const paid: AutoHttpResponse = {
  status: 200,
  headers: {
    'PAYMENT-RESPONSE': encodePaymentResponseHeader({
      success: true,
      network: 'eip155:8453',
      transaction: `0x${'1'.repeat(64)}`,
      payer: '0x2222222222222222222222222222222222222222',
    }),
  },
  body: '{"results":[{"url":"https://example.com","title":"Router"}]}',
};
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function setup(overrides: Partial<ExecutionDeps> = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tenjin-auto-execution-'));
  dirs.push(stateDir);
  const readPolicy = vi.fn(async () => ({ ...initialPolicy }));
  const signPayment = vi.fn(async (value: PaymentRequired) => ({
    headers: { 'PAYMENT-SIGNATURE': 'fake-fixture' },
    amountAtomic: BigInt(value.accepts[0]!.amount),
  }));
  const transport = vi.fn(async (_request, headers) => (headers ? paid : challenge()));
  const deps: ExecutionDeps = {
    stateDir,
    readPolicy,
    signPayment,
    transport,
    now: () => 1000,
    ...overrides,
  };
  return { deps, readPolicy, signPayment, transport, stateDir };
}
function secondInput(): PaidRequestInput {
  return { ...input, identity: { ...input.identity, requestId: 'tool-2' } };
}
async function ledgerFile(dir: string): Promise<string> {
  return join(
    dir,
    (await readdir(dir)).find((name) => name.endsWith('.json'))!,
  );
}

describe('deterministic auto payment execution', () => {
  it('signs once, retains evidence, and delivers a saved result without another HTTP request', async () => {
    const { deps, signPayment, transport } = await setup();
    const result = await executePaidRequest(input, deps);
    expect(result).toMatchObject({
      status: 'fulfilled',
      amountAtomic: '7000',
      settlement: { status: 'reported' },
    });
    expect(signPayment).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(await executePaidRequest(input, deps)).toEqual({ ...result, cached: true });
    expect(signPayment).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledTimes(2);
    const ledger = await readFile(await ledgerFile(deps.stateDir), 'utf8');
    expect(ledger).not.toContain('fake-fixture');
    expect(ledger).not.toContain('PAYMENT-SIGNATURE');
  });

  it('uses the installed SDK to sign the exact catalog-bound requirement offline', async () => {
    const signed = vi.fn(async (q: PaymentRequired) => buildExactPayment(q, testSigner()));
    const { deps, transport } = await setup({ signPayment: signed });
    expect((await executePaidRequest(input, deps)).status).toBe('fulfilled');
    const headers = transport.mock.calls[1]?.[1] as Record<string, string>;
    const payload = decodePaymentSignatureHeader(headers['PAYMENT-SIGNATURE']!);
    expect(payload.accepted).toMatchObject({ amount: '7000', payTo: quote.accepts[0]!.payTo });
  });

  it.each<[Partial<AutoPolicy>, string]>([
    [{ authorization: 'disabled' }, 'needs_approval'],
    [{ expiresAtMs: 1000 }, 'needs_approval'],
    [{ allowedOperations: ['fetch'] }, 'needs_approval'],
    [{ allowedOrigins: ['https://other.example'] }, 'needs_approval'],
    [{ maxCallAtomic: '0' }, 'refused'],
    [{ maxRunAtomic: '0' }, 'refused'],
    [{ maxCallAtomic: '5000' }, 'refused'],
  ])('enforces structured policy %j without asking a model', async (change, status) => {
    const { deps, signPayment } = await setup({
      readPolicy: async () => ({
        ...initialPolicy,
        ...change,
      }),
    });
    expect((await executePaidRequest(input, deps)).status).toBe(status);
    expect(signPayment).not.toHaveBeenCalled();
  });

  it('counts reservations across concurrent requests and separate sessions in one run', async () => {
    let release!: () => void;
    let didSign!: () => void;
    const started = new Promise<void>((resolve) => {
      didSign = resolve;
    });
    const blockedSign = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, signPayment } = await setup({
      readPolicy: async () => ({ ...initialPolicy, maxRunAtomic: '10000' }),
    });
    signPayment.mockImplementation(async () => {
      didSign();
      await blockedSign;
      return { headers: { 'PAYMENT-SIGNATURE': 'fake-fixture' }, amountAtomic: 7000n };
    });
    const first = executePaidRequest(input, deps);
    await started;
    const other = secondInput();
    other.identity = { ...other.identity, sessionId: 'other-session' };
    const second = await executePaidRequest(other, deps);
    expect(second).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('remaining run cap'),
    });
    release();
    expect((await first).status).toBe('fulfilled');
    expect(signPayment).toHaveBeenCalledOnce();
  });

  it('claims identity before network work so concurrent duplicate hooks cannot both sign', async () => {
    let release!: () => void;
    let probed!: () => void;
    const started = new Promise<void>((resolve) => {
      probed = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, signPayment } = await setup({
      transport: async (_req, headers) => {
        if (headers) return paid;
        probed();
        await pending;
        return challenge();
      },
    });
    const first = executePaidRequest(input, deps);
    await started;
    expect((await executePaidRequest(input, deps)).status).toBe('pending');
    release();
    expect((await first).status).toBe('fulfilled');
    expect(signPayment).toHaveBeenCalledOnce();
  });

  it('never reuses an identity after arguments, context, or contract change', async () => {
    const { deps, signPayment } = await setup();
    await executePaidRequest(input, deps);
    const result = await executePaidRequest(
      { ...input, identity: { ...input.identity, contractHash: 'new-contract' } },
      deps,
    );
    expect(result).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('already bound'),
    });
    expect(signPayment).toHaveBeenCalledOnce();
  });

  it('enforces resource and method scopes before the unsigned request, even under a search label', async () => {
    const { deps, transport, signPayment } = await setup({
      readPolicy: async () => ({
        ...initialPolicy,
        allowedResources: [{ url: endpoint, method: 'GET' }],
      }),
    });
    expect(await executePaidRequest(input, deps)).toMatchObject({
      status: 'needs_approval',
      reason: expect.stringContaining('concrete resource'),
    });
    expect(transport).not.toHaveBeenCalled();
    expect(signPayment).not.toHaveBeenCalled();
  });

  it('permits query arguments under an explicit origin/path/method scope', async () => {
    const { deps } = await setup({
      readPolicy: async () => ({
        ...initialPolicy,
        allowedResources: [{ url: endpoint, method: 'GET' }],
      }),
    });
    const queried = { ...input, request: { url: `${endpoint}?query=router`, method: 'GET' } };
    expect((await executePaidRequest(queried, deps)).status).toBe('fulfilled');
  });

  it('delivers completed results after policy expiry without requesting permission or spending again', async () => {
    const { deps, readPolicy, signPayment, transport } = await setup();
    await executePaidRequest(input, deps);
    readPolicy.mockResolvedValue({ ...initialPolicy, authorization: 'disabled', expiresAtMs: 1 });
    expect(await executePaidRequest(input, deps)).toMatchObject({
      status: 'fulfilled',
      cached: true,
    });
    expect(signPayment).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('rechecks changed policy before signing', async () => {
    const { deps, signPayment } = await setup({
      readPolicy: vi
        .fn()
        .mockResolvedValueOnce(initialPolicy)
        .mockResolvedValue({ ...initialPolicy, revision: '2' }),
    });
    expect((await executePaidRequest(input, deps)).status).toBe('needs_approval');
    expect(signPayment).not.toHaveBeenCalled();
  });

  it('discards a signature if policy is revoked during signing, without sending it', async () => {
    let policy = initialPolicy;
    const { deps, signPayment, transport } = await setup({ readPolicy: async () => policy });
    signPayment.mockImplementation(async () => {
      policy = { ...policy, revision: '2', authorization: 'disabled' };
      return { headers: { 'PAYMENT-SIGNATURE': 'never-send' }, amountAtomic: 7000n };
    });
    expect((await executePaidRequest(input, deps)).status).toBe('needs_approval');
    expect(transport).toHaveBeenCalledTimes(1);
    const ledger = JSON.parse(await readFile(await ledgerFile(deps.stateDir), 'utf8'));
    expect(ledger.attempts[0]).toMatchObject({ state: 'cancelled', amountAtomic: '0' });
  });

  it.each(['signing', 'transmission'])(
    'retains budget and forbids retry after ambiguous %s failure',
    async (phase) => {
      const { deps, signPayment, transport } = await setup({
        readPolicy: async () => ({ ...initialPolicy, maxRunAtomic: '10000' }),
      });
      if (phase === 'signing') signPayment.mockRejectedValue(new Error('signer unavailable'));
      else
        transport.mockImplementation(async (_req, headers) => {
          if (headers) throw new Error('timeout');
          return challenge();
        });
      expect(await executePaidRequest(input, deps)).toMatchObject({
        status: 'failed',
        amountAtomic: '7000',
      });
      expect((await executePaidRequest(input, deps)).status).toBe('pending');
      expect((await executePaidRequest(secondInput(), deps)).status).toBe('refused');
      expect(signPayment).toHaveBeenCalledOnce();
    },
  );

  it('retains the full spend after a paid 402 response and never signs a revised quote automatically', async () => {
    const { deps, signPayment } = await setup({ transport: async () => challenge() });
    const result = await executePaidRequest(input, deps);
    expect(result).toMatchObject({ status: 'failed', amountAtomic: '7000' });
    expect(await executePaidRequest(input, deps)).toMatchObject({ ...result, cached: true });
    expect(signPayment).toHaveBeenCalledOnce();
  });

  it('does not present HTTP success alone as verified settlement', async () => {
    const { deps } = await setup({
      transport: async (_req, headers) => (headers ? { ...paid, headers: {} } : challenge()),
    });
    expect(await executePaidRequest(input, deps)).toMatchObject({
      status: 'fulfilled',
      settlement: { status: 'unverified' },
    });
  });

  it('reports actionable stage and network code without persisting raw transport error text', async () => {
    const { deps } = await setup({
      transport: async () => {
        throw Object.assign(new TypeError('sensitive transport text'), { code: 'ECONNRESET' });
      },
    });
    const result = await executePaidRequest(input, deps);
    expect(result).toMatchObject({
      status: 'failed',
      diagnostic: { stage: 'unsigned-request', errorName: 'TypeError', errorCode: 'ECONNRESET' },
    });
    expect(JSON.stringify(result)).not.toContain('sensitive transport text');
    expect(await readFile(await ledgerFile(deps.stateDir), 'utf8')).not.toContain(
      'sensitive transport text',
    );
  });

  it('does not expose arbitrary error name or code fields as diagnostics', async () => {
    const { deps } = await setup({
      transport: async () => {
        throw { name: 'sensitive-name', code: 'sensitive-code' };
      },
    });
    const result = await executePaidRequest(input, deps);
    expect(result.diagnostic).toEqual({ stage: 'unsigned-request', errorName: 'UnknownError' });
    expect(JSON.stringify(result)).not.toContain('sensitive-');
  });

  it('fails closed on a corrupt ledger and does not reset its budget', async () => {
    const { deps, signPayment, transport } = await setup();
    await executePaidRequest(input, deps);
    const path = await ledgerFile(deps.stateDir);
    await writeFile(path, '{broken');
    expect((await executePaidRequest(secondInput(), deps)).status).toBe('refused');
    expect(await readFile(path, 'utf8')).toBe('{broken');
    expect(signPayment).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['payTo', '0x3333333333333333333333333333333333333333', 'refused'],
    ['amount', '7001', 'refused'],
    ['network', 'eip155:1', 'unsupported'],
    ['asset', '0x3333333333333333333333333333333333333333', 'unsupported'],
    ['scheme', 'upto', 'unsupported'],
  ])('refuses changed or unsupported quote %s', async (field, value, expected) => {
    const altered = { ...quote, accepts: [{ ...quote.accepts[0]!, [field]: value }] };
    const { deps, signPayment } = await setup({ transport: async () => challenge(altered) });
    expect((await executePaidRequest(input, deps)).status).toBe(expected);
    expect(signPayment).not.toHaveBeenCalled();
  });

  it('rejects a challenge naming a different resource', async () => {
    const { deps, signPayment } = await setup({
      transport: async () =>
        challenge({
          ...quote,
          resource: { ...quote.resource, url: 'https://other.example/search' },
        }),
    });
    expect((await executePaidRequest(input, deps)).status).toBe('refused');
    expect(signPayment).not.toHaveBeenCalled();
  });

  it('accepts a queryless quote for the same endpoint while preserving actual GET arguments', async () => {
    const { deps, transport } = await setup();
    const queried = { ...input, request: { url: `${endpoint}?query=router`, method: 'GET' } };
    expect((await executePaidRequest(queried, deps)).status).toBe('fulfilled');
    expect(transport.mock.calls.map(([request]) => request.url)).toEqual([
      queried.request.url,
      queried.request.url,
    ]);
  });

  it('refuses a quote that substitutes its own query arguments', async () => {
    const { deps, signPayment } = await setup({
      transport: async () =>
        challenge({ ...quote, resource: { ...quote.resource, url: `${endpoint}?query=other` } }),
    });
    const queried = { ...input, request: { url: `${endpoint}?query=router`, method: 'GET' } };
    expect((await executePaidRequest(queried, deps)).status).toBe('refused');
    expect(signPayment).not.toHaveBeenCalled();
  });

  it('refuses missing saved-result state instead of treating it as an empty cache hit', async () => {
    const { deps, signPayment } = await setup();
    await executePaidRequest(input, deps);
    const path = await ledgerFile(deps.stateDir);
    const ledger = JSON.parse(await readFile(path, 'utf8'));
    delete ledger.attempts[0].result;
    await writeFile(path, JSON.stringify(ledger));
    expect((await executePaidRequest(input, deps)).status).toBe('refused');
    expect(signPayment).toHaveBeenCalledOnce();
  });

  it('refuses redirects, injected payment headers, and private destinations before signing', async () => {
    const { deps, signPayment } = await setup({
      transport: async () => ({ status: 302, headers: {}, body: '' }),
    });
    expect((await executePaidRequest(input, deps)).status).toBe('refused');
    expect(
      (
        await executePaidRequest(
          { ...input, request: { ...input.request, url: 'https://127.0.0.1/api' } },
          deps,
        )
      ).status,
    ).toBe('refused');
    expect(
      (
        await executePaidRequest(
          { ...input, request: { ...input.request, headers: { 'PAYMENT-SIGNATURE': 'injected' } } },
          deps,
        )
      ).status,
    ).toBe('unsupported');
    expect(signPayment).not.toHaveBeenCalled();
  });
});

describe('endpoint transport guards', () => {
  function serve(status = 200, body = 'result') {
    network.request.mockReset();
    network.lookup.mockReset().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    network.request.mockImplementation(
      (_url: URL, _options: RequestOptions, callback: (incoming: IncomingMessage) => void) => {
        const outgoing = new EventEmitter() as EventEmitter & {
          end: () => void;
          destroy: (error: Error) => void;
        };
        outgoing.destroy = (error) => {
          outgoing.emit('error', error);
        };
        outgoing.end = () => {
          const incoming = Object.assign(new EventEmitter(), {
            statusCode: status,
            headers: { 'content-type': 'application/json' },
          });
          callback(incoming as unknown as IncomingMessage);
          incoming.emit('data', Buffer.from(body));
          incoming.emit('end');
        };
        return outgoing;
      },
    );
  }

  it('uses exactly the previously checked DNS address for the HTTPS connection', async () => {
    serve();
    const response = await safeHttpsTransport(input.request, { 'PAYMENT-SIGNATURE': 'fixture' });
    expect(response).toMatchObject({ status: 200, body: 'result' });
    expect(network.lookup).toHaveBeenCalledOnce();
    const options = network.request.mock.calls[0]![1] as RequestOptions;
    const callback = vi.fn();
    const pinnedLookup = options.lookup as unknown as (
      host: string,
      options: { all: boolean },
      cb: typeof callback,
    ) => void;
    pinnedLookup('vendor.example', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
    expect(options.headers).toMatchObject({ 'PAYMENT-SIGNATURE': 'fixture' });
    expect(network.lookup).toHaveBeenCalledOnce();
  });

  it('allows connection-family fallback across all validated addresses without another lookup or HTTP retry', async () => {
    serve();
    const addresses = [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    network.lookup.mockResolvedValue(addresses);
    await safeHttpsTransport(input.request, { 'PAYMENT-SIGNATURE': 'fixture' });
    const options = network.request.mock.calls[0]![1] as RequestOptions & {
      autoSelectFamily: boolean;
    };
    expect(options).toMatchObject({ agent: false, autoSelectFamily: true });
    const callback = vi.fn();
    const pinnedLookup = options.lookup as unknown as (
      host: string,
      options: { all: boolean },
      cb: typeof callback,
    ) => void;
    pinnedLookup('vendor.example', { all: true }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, addresses);
    pinnedLookup('vendor.example', { all: false }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, '8.8.8.8', 4);
    expect(network.lookup).toHaveBeenCalledOnce();
    expect(network.request).toHaveBeenCalledOnce();
  });

  it('refuses mixed public/private DNS responses before opening a connection', async () => {
    serve();
    network.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ]);
    await expect(safeHttpsTransport(input.request)).rejects.toThrow('private');
    expect(network.request).not.toHaveBeenCalled();
  });

  it('never follows an HTTP redirect with a payment header', async () => {
    serve(302);
    expect(
      (await safeHttpsTransport(input.request, { 'PAYMENT-SIGNATURE': 'fixture' })).status,
    ).toBe(302);
    expect(network.request).toHaveBeenCalledOnce();
  });

  it('aborts oversized responses rather than silently truncating saved paid results', async () => {
    serve(200, 'x'.repeat(262_145));
    await expect(safeHttpsTransport(input.request)).rejects.toThrow('Response exceeds');
  });

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '100.100.100.100',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2002:7f00:1::',
  ])('rejects special/private address %s', (value) => {
    expect(isPublicAddress(value)).toBe(false);
  });
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('accepts public address %s', (value) => {
    expect(isPublicAddress(value)).toBe(true);
  });
  it.each([
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com:8443',
    'https://localhost',
    'https://anything.internal',
    'https://example.com/#fragment',
  ])('refuses unsafe endpoint %s', (url) => {
    expect(() => assertRequestSafe({ url, method: 'GET' })).toThrow();
  });
});

describe('nested target argument validation', () => {
  const uriSchema = {
    type: 'object',
    properties: {
      body: { type: 'object', properties: { target: { type: 'string', format: 'uri' } } },
    },
  };
  const publicResolver = () =>
    vi.fn(async (_hostname: string) => [{ address: '8.8.8.8', family: 4 }]);

  it.each([
    'file:///etc/passwd',
    'gopher://example.com/resource',
    'http://example.com',
    'javascript:alert(1)',
    'data:text/plain,hello',
    'https://127.0.0.1',
    'https://[::1]',
    'https://example.com:8443',
  ])('rejects structured target %s before DNS', async (target) => {
    const resolveHostname = publicResolver();
    await expect(
      validateNestedTargets({ body: { target } }, uriSchema, { resolveHostname }),
    ).rejects.toThrow('public HTTPS');
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it('validates nested array targets and resolves each distinct hostname only once', async () => {
    const resolveHostname = publicResolver();
    await validateNestedTargets(
      {
        body: {
          pages: [
            'https://example.com/one',
            'https://example.com/two',
            'https://example.org/three',
          ],
        },
      },
      {},
      { resolveHostname },
    );
    expect(resolveHostname.mock.calls).toEqual([['example.com'], ['example.org']]);
  });

  it('does not mistake ordinary query prose, CAIP identifiers, or wallet addresses for targets', async () => {
    const resolveHostname = publicResolver();
    await validateNestedTargets(
      {
        query: 'Explain file:// and https:// URL syntax with examples',
        network: 'eip155:8453',
        account: 'eip155:8453:0x1111111111111111111111111111111111111111',
        address: '0x1111111111111111111111111111111111111111',
      },
      {},
      { resolveHostname },
    );
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it('catches opaque URI-shaped values even when the schema omits formats', async () => {
    await expect(
      validateNestedTargets(
        { body: { arbitrary: 'gopher://example.com/route' } },
        {},
        { resolveHostname: publicResolver() },
      ),
    ).rejects.toThrow('public HTTPS');
  });

  it('rejects a public-looking hostname resolving to any private address', async () => {
    const resolveHostname = vi.fn(async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    await expect(
      validateNestedTargets(
        { body: { url: 'https://public-looking.example' } },
        {},
        { resolveHostname },
      ),
    ).rejects.toThrow('private');
    expect(resolveHostname).toHaveBeenCalledOnce();
  });

  it('rejects unresolvable hosts without exposing resolver messages', async () => {
    const resolveHostname = vi.fn(async () => {
      throw new Error('private resolver detail');
    });
    await expect(
      validateNestedTargets(
        { body: { url: 'https://unavailable.example' } },
        {},
        { resolveHostname },
      ),
    ).rejects.toThrow('DNS resolution failed before payment');
  });

  it('bounds DNS waiting across all targets', async () => {
    const resolveHostname = vi.fn(
      async () => new Promise<{ address: string; family: number }[]>(() => {}),
    );
    await expect(
      validateNestedTargets(
        { url: 'https://never-resolves.example' },
        {},
        { resolveHostname, timeoutMs: 5 },
      ),
    ).rejects.toThrow('timed out');
  });

  it('rejects malformed URI fields and bounds the number of targets before DNS', async () => {
    const resolveHostname = publicResolver();
    await expect(
      validateNestedTargets({ url: 'some query text' }, {}, { resolveHostname }),
    ).rejects.toThrow('valid public HTTPS');
    await expect(
      validateNestedTargets(
        { urls: Array.from({ length: 33 }, (_, index) => `https://example.com/${index}`) },
        {},
        { resolveHostname },
      ),
    ).rejects.toThrow('32 distinct');
    expect(resolveHostname).not.toHaveBeenCalled();
  });
});
