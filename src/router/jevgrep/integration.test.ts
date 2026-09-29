import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CommandContext } from '../../context';
import { testWalletProvider } from '../../lib/read-test-utils';
import { createLocalSpendAuthorizer } from '../../lib/wallet/spend';
import { runNativeHook, runPromptHook } from '../hooks';
import { buildRouterMcpServer } from '../mcp';
import { runRequestTool } from '../tool';
import type { JevgrepGrant } from './grants';
import { createJevgrepPayer } from './payments';
import { runJevgrep } from './runner';

vi.mock('./runner', () => ({ runJevgrep: vi.fn() }));
vi.mock('./payments', async () => ({
  ...(await import('./supplier')),
  createJevgrepPayer: vi.fn(),
}));

const ID = 'jev-offer-123';
const QUERY = 'Explain how source filtering and retrieval boundaries interact in this repository.';
const fields = {
  action: 'execute',
  capabilityId: 'jevgrep-search-v1',
  category: 'repository retrieval',
  provider: 'Jevgrep',
  capabilityDescription: 'Semantic retrieval from an approved repository',
  pricing: 'bounded_locally',
};
const hookAnswer = {
  schemaVersion: 1,
  routerVersion: 'fixture',
  decision: {
    ...fields,
    id: ID,
    endpoint: 'https://github.com/dzhng/jevgrep',
    usage: QUERY,
    hint: `Consider request({query: "${QUERY}", id: "${ID}"}); native tools remain available.`,
  },
};
const toolAnswer = (query: string) => ({
  schemaVersion: 1,
  routerVersion: 'fixture',
  decision: { ...fields, contract: { executor: 'jevgrep-search-v1', query } },
});

let dir: string;
let root: string;
let grant: JevgrepGrant;
let ctx: CommandContext;
let sent: { headers: Headers; body: Record<string, unknown> }[];
let beforeToolResponse: (() => Promise<void>) | undefined;
let provider: ReturnType<typeof testWalletProvider>;
let authorizer: ReturnType<typeof createLocalSpendAuthorizer>;
const evaluate = vi.fn(async () => ({
  answers: { relevant: { type: 'noul' as const, noul: 0.8 } },
}));
const summary = vi.fn(async () => ({
  exposureAtomic: '0',
  confirmedAtomic: '0',
  unknownAtomic: '0',
  reservedAtomic: '0',
  requests: 0,
  replays: 0,
}));
const fetchImpl = (async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  sent.push({ headers: new Headers(init?.headers), body });
  if (!body.packet) await beforeToolResponse?.();
  return new Response(JSON.stringify(body.packet ? hookAnswer : toolAnswer(String(body.query))), {
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

beforeEach(async () => {
  vi.clearAllMocks();
  sent = [];
  beforeToolResponse = undefined;
  dir = await realpath(await mkdtemp(join(tmpdir(), 'jevgrep-integration-')));
  root = join(dir, 'repo');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(dir, 'jevgrep'), { mode: 0o700 });
  await writeFile(join(dir, 'runtime.tgz'), 'Never executed by these tests');
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      maxAutoSpend: '50000',
      sessionBudget: '500000',
      baseUrl: 'https://router.example',
    }),
  );
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  ctx = {
    dataDir: dir,
    flags: { json: true, timeout: 1000 },
    io: { stdout: sink, stderr: sink, isTTY: false },
  };
  grant = {
    version: 1,
    id: randomUUID(),
    enabled: true,
    root,
    source: 'committed-tracked',
    supplier: 'jev-x402',
    shareSource: true,
    maxRunAtomic: '50000',
    runtime: { kind: 'local-artifact', path: join(dir, 'runtime.tgz'), sha256: 'a'.repeat(64) },
  };
  await saveGrant();
  provider = testWalletProvider();
  authorizer = createLocalSpendAuthorizer({
    dir,
    policy: { maxAutoSpendAtomic: 50_000n, sessionBudgetAtomic: 500_000n, allowlistCreators: [] },
  });
  vi.mocked(createJevgrepPayer).mockReturnValue({
    evaluate,
    summary,
    close: vi.fn().mockResolvedValue({ drainCompleted: true, pendingEvaluations: 0 }),
  });
  vi.mocked(runJevgrep).mockResolvedValue({
    status: 'complete',
    output: 'fixture.ts:1',
    requests: 0,
  });
});
afterEach(async () => {
  // A cancelled MCP client can finish before its server persists terminal progress.
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
});
async function saveGrant() {
  await writeFile(join(dir, 'jevgrep', 'grant.json'), JSON.stringify(grant), { mode: 0o600 });
}
function offer(prompt = QUERY, cwd = root) {
  return runPromptHook(
    { hook_event_name: 'UserPromptSubmit', session_id: 'session-one', cwd, prompt },
    { dataDir: dir, fetchImpl, warn: () => undefined },
  );
}
function request(query = QUERY, cwd = root, id: string | undefined = ID) {
  return runRequestTool(
    { query, ...(id ? { id } : {}) },
    { ctx, cwd, provider, authorizer, fetchImpl },
  );
}

describe('Jevgrep hook, binding and executor integration', () => {
  it.each(['complete', 'partial'] as const)(
    'reports answer reuse on a %s retrieval',
    async (status) => {
      await offer();
      vi.mocked(runJevgrep).mockResolvedValue({
        status,
        output: 'fixture.ts:1',
        requests: 2,
        cacheHits: 17,
      });
      const result = await request();
      expect(result.envelope).toMatchObject({
        status: status === 'complete' ? 'fulfilled' : 'partial',
        requests: 2,
        cacheHits: 17,
      });
      expect(result.envelope.cost).toEqual(await summary());
    },
  );
  it('caps the whole search at the current automatic-operation ceiling', async () => {
    await offer();
    // Tightening policy after the offer must constrain the entire search at dispatch.
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        maxAutoSpend: '1000',
        sessionBudget: '500000',
        baseUrl: 'https://router.example',
      }),
    );
    expect((await request()).envelope.status).toBe('fulfilled');
    expect(createJevgrepPayer).toHaveBeenCalledWith(
      expect.objectContaining({ maxRunAtomic: 1000n }),
    );
    expect(grant.maxRunAtomic).toBe('50000');
    expect(runJevgrep).toHaveBeenCalledOnce();
  });

  it('keeps a smaller explicit source-grant budget as the whole-search ceiling', async () => {
    grant.maxRunAtomic = '2000';
    await saveGrant();
    await offer();
    expect((await request()).envelope.status).toBe('fulfilled');
    expect(createJevgrepPayer).toHaveBeenCalledWith(
      expect.objectContaining({ maxRunAtomic: 2000n }),
    );
  });

  it('advertises eligibility, privately binds the offer, and dispatches only local dependencies', async () => {
    expect(await offer()).toMatchObject({ action: 'execute', id: ID });
    const bindingPath = join(dir, 'jevgrep', 'bindings', `${ID}.json`);
    expect((await stat(bindingPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(bindingPath, 'utf8'))).toMatchObject({
      root,
      grantId: grant.id,
      sessionId: 'session-one',
    });
    const result = await request();
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      executor: 'jevgrep-search-v1',
      source: 'committed-tracked',
      result: 'fixture.ts:1',
      providerContentUntrusted: true,
    });
    expect(sent).toHaveLength(2);
    expect(
      sent.every((call) =>
        call.headers.get('Tenjin-Router-Executors')?.includes('jevgrep-search-v1'),
      ),
    ).toBe(true);
    expect(JSON.stringify(sent.map((call) => call.body))).not.toContain(root);
    const options = vi.mocked(runJevgrep).mock.calls[0]![0];
    expect(options.root).toBe(root);
    expect(options.query).toBe(QUERY);
    expect(options.runtime).toEqual(grant.runtime);
    expect(options.dataDir).toBe(ctx.dataDir);
    expect(Object.keys(options).sort()).toEqual([
      'dataDir',
      'evaluate',
      'profile',
      'query',
      'root',
      'runtime',
    ]);
    expect(JSON.stringify(options)).not.toMatch(/wallet|bearer|authorization|privateKey/);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([
    'wrong-root',
    'disabled',
    'replaced-grant',
    'missing-id',
    'no-upload',
    'router-off',
  ] as const)('blocks runtime and payment for %s after a real offer', async (kind) => {
    await offer();
    if (kind === 'disabled') {
      grant.enabled = false;
      await saveGrant();
    }
    if (kind === 'replaced-grant') {
      grant.id = randomUUID();
      await saveGrant();
    }
    if (kind === 'router-off')
      await writeFile(join(dir, 'config.json'), JSON.stringify({ router: { enabled: false } }));
    const result =
      kind === 'missing-id'
        ? await runRequestTool(
            { query: QUERY },
            { ctx, cwd: root, provider, authorizer, fetchImpl },
          )
        : await request(
            kind === 'no-upload' ? `${QUERY} Do not upload source.` : QUERY,
            kind === 'wrong-root' ? dir : root,
          );
    expect(result.envelope.status).not.toBe('fulfilled');
    expect(runJevgrep).not.toHaveBeenCalled();
    expect(createJevgrepPayer).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    const toolCall = sent.find((call) => !call.body.packet);
    if (toolCall)
      expect(toolCall.headers.get('Tenjin-Router-Executors')).not.toContain('jevgrep-search-v1');
  });

  it('does not advertise or bind a disclosure-forbidden prompt', async () => {
    expect((await offer(`${QUERY} No paid calls and do not upload source.`)).response).toBeNull();
    expect(sent[0]!.headers.get('Tenjin-Router-Executors')).not.toContain('jevgrep-search-v1');
    await expect(stat(join(dir, 'jevgrep', 'bindings', `${ID}.json`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(runJevgrep).not.toHaveBeenCalled();
  });

  it('rechecks a grant revoked while the tool decision is in flight', async () => {
    await offer();
    beforeToolResponse = async () => {
      grant.enabled = false;
      await saveGrant();
    };
    expect((await request()).envelope.status).toBe('needs_input');
    expect(runJevgrep).not.toHaveBeenCalled();
    expect(createJevgrepPayer).not.toHaveBeenCalled();
  });

  it('rechecks router disablement while the tool decision is in flight', async () => {
    await offer();
    beforeToolResponse = async () => {
      await writeFile(
        join(dir, 'config.json'),
        JSON.stringify({
          maxAutoSpend: '50000',
          sessionBudget: '500000',
          router: { enabled: false },
        }),
      );
    };
    expect((await request()).envelope.status).not.toBe('fulfilled');
    expect(runJevgrep).not.toHaveBeenCalled();
    expect(createJevgrepPayer).not.toHaveBeenCalled();
  });

  it('leaves native grep calls untouched even with an enabled source grant', async () => {
    const outcome = await runNativeHook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'session-one',
        cwd: root,
        tool_name: 'Grep',
        tool_input: { pattern: 'credential', path: root },
        tool_use_id: 'grep-1',
      },
      { dataDir: dir, fetchImpl, warn: () => undefined },
    );
    expect(outcome.response).toBeNull();
    expect(sent).toHaveLength(0);
    expect(createJevgrepPayer).not.toHaveBeenCalled();
    expect(runJevgrep).not.toHaveBeenCalled();
  });

  it.each(['request-cancel', 'disconnect'] as const)(
    'passes MCP %s to an active executor',
    async (kind) => {
      await offer();
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      let finished!: () => void;
      const stopped = new Promise<void>((resolve) => {
        finished = resolve;
      });
      let observed: AbortSignal | undefined;
      vi.mocked(runJevgrep).mockImplementation(async (options) => {
        observed = options.signal;
        started();
        await new Promise<void>((resolve) =>
          options.signal!.addEventListener('abort', () => resolve(), { once: true }),
        );
        finished();
        return { status: 'cancelled', output: '', requests: 0, reason: 'cancelled' };
      });
      const server = buildRouterMcpServer({
        dataDir: dir,
        handlerDeps: { cwd: root, provider, authorizer, fetchImpl },
      });
      const client = new Client({ name: 'integration-test', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const controller = new AbortController();
      const pending = client
        .callTool({ name: 'request', arguments: { query: QUERY, id: ID } }, undefined, {
          signal: controller.signal,
        })
        .catch(() => undefined);
      try {
        await entered;
        if (kind === 'request-cancel') controller.abort();
        else await client.close();
        await stopped;
        expect(observed?.aborted).toBe(true);
        expect(evaluate).not.toHaveBeenCalled();
        await pending;
      } finally {
        controller.abort();
        await client.close();
        await server.close();
      }
    },
  );
});

it('keeps extended profile opt-in while preserving the current wallet clamp', async () => {
  grant.maxRunAtomic = '1000000';
  await saveGrant();
  await offer();
  expect((await request()).envelope.status).toBe('fulfilled');
  expect(createJevgrepPayer).toHaveBeenCalledWith(
    expect.objectContaining({ profile: 'extended-v1', maxRunAtomic: 50000n }),
  );
  expect(runJevgrep).toHaveBeenCalledWith(expect.objectContaining({ profile: 'extended-v1' }));
});
it('never reports fulfilled if payment work failed to drain before summary', async () => {
  await offer();
  const closed = vi.fn().mockResolvedValue({ drainCompleted: false, pendingEvaluations: 1 });
  vi.mocked(createJevgrepPayer).mockReturnValue({ evaluate, summary, close: closed });
  const result = await request();
  expect(result.isError).toBe(true);
  expect(result.envelope).toMatchObject({
    status: 'partial',
    stopReason: 'payment-drain-timeout',
    drainCompleted: false,
    pendingEvaluations: 1,
  });
  expect(closed).toHaveBeenCalledOnce();
});
