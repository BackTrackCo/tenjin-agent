import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccountBadInput,
  AccountLimited,
  AccountRefused,
  CLOSE_TIMEOUT_MS,
  openAccountSession,
} from './client';

/**
 * A SESSION WITH AN ACCOUNT'S MCP SERVER through the SDK's own client, against
 * a scripted streamable HTTP server behind the injected fetch: the credential
 * rides in the header on every request, tools are read across pages, and a
 * refused credential comes back as one error the caller can read.
 */

const MCP = 'https://mcp.example.test/mcp';

function scriptedServer(
  opts: { refuse?: boolean; status?: number; badArgs?: boolean; stallDelete?: boolean } = {},
) {
  const seen: { method: string; rpc?: string; authorization?: string }[] = [];
  const aborted: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    seen.push({
      method,
      ...(typeof body.method === 'string' ? { rpc: body.method } : {}),
      ...(headers.get('authorization') !== null
        ? { authorization: headers.get('authorization')! }
        : {}),
    });
    if (url !== MCP) return new Response(null, { status: 404 });
    if (opts.refuse === true) return new Response('{}', { status: 401 });
    // A server that never answers the session's end: only an abort settles it.
    if (method === 'DELETE' && opts.stallDelete === true) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted.push(method);
          reject(new Error('aborted'));
        });
      });
    }
    if (method !== 'POST') return new Response(null, { status: 405 });
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
      });
    switch (body.method) {
      case 'initialize':
        return reply({
          protocolVersion: (body.params as { protocolVersion: string }).protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'example', version: '1.0.0' },
        });
      case 'notifications/initialized':
        return new Response(null, { status: 202 });
      case 'tools/list': {
        const cursor = (body.params as { cursor?: string } | undefined)?.cursor;
        return cursor === undefined
          ? reply({
              tools: [
                {
                  name: 'call-actor',
                  description: 'Run an Actor',
                  inputSchema: { type: 'object', properties: { actor: {}, input: {} } },
                },
              ],
              nextCursor: 'page-2',
            })
          : reply({ tools: [{ name: 'get-dataset-items', inputSchema: { type: 'object' } }] });
      }
      case 'tools/call':
        if (opts.status !== undefined) return new Response('{}', { status: opts.status });
        if (opts.badArgs === true)
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              error: { code: -32602, message: 'actor is required' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        return reply({ content: [{ type: 'text', text: '{"ok":true}' }], isError: false });
      default:
        return reply({});
    }
  }) as typeof fetch;
  return { fetchImpl, seen, aborted };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a session with an account', () => {
  it('lists every page of tools and calls one, with the credential on each request', async () => {
    const server = scriptedServer();
    const session = await openAccountSession(
      MCP,
      { authorization: 'Bearer token-1' },
      { fetchImpl: server.fetchImpl },
    );
    expect(await session.listTools()).toEqual([
      {
        name: 'call-actor',
        description: 'Run an Actor',
        arguments: ['actor', 'input'],
        inputSchema: { type: 'object', properties: { actor: {}, input: {} } },
      },
      { name: 'get-dataset-items', arguments: [], inputSchema: { type: 'object' } },
    ]);
    expect(await session.callTool('call-actor', { actor: 'a/b', input: {} })).toMatchObject({
      isError: false,
    });
    await session.close();
    const posts = server.seen.filter(({ method }) => method === 'POST');
    expect(posts.map(({ rpc }) => rpc)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/list',
      'tools/call',
    ]);
    for (const request of server.seen) expect(request.authorization).toBe('Bearer token-1');
  });

  it('reads a refused credential as AccountRefused', async () => {
    const server = scriptedServer({ refuse: true });
    const error = await openAccountSession(
      MCP,
      { authorization: 'Bearer wrong' },
      { fetchImpl: server.fetchImpl },
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AccountRefused);
    expect((error as AccountRefused).status).toBe(401);
  });

  it('reads a plan or rate limit, and arguments the server refused, as what they are', async () => {
    for (const status of [402, 429] as const) {
      const server = scriptedServer({ status });
      const session = await openAccountSession(MCP, {}, { fetchImpl: server.fetchImpl });
      const error = await session.callTool('call-actor', {}).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(AccountLimited);
      expect((error as AccountLimited).status).toBe(status);
      await session.close();
    }
    const server = scriptedServer({ badArgs: true });
    const session = await openAccountSession(MCP, {}, { fetchImpl: server.fetchImpl });
    const error = await session.callTool('call-actor', {}).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AccountBadInput);
    await session.close();
  });

  it('closes within its bound when the server never answers the end of the session', async () => {
    // A1igator review: close() awaited the SDK's DELETE, which has no
    // timeout, so a stalled server held a finished result past every deadline.
    const server = scriptedServer({ stallDelete: true });
    const session = await openAccountSession(MCP, {}, { fetchImpl: server.fetchImpl });
    await session.listTools();
    vi.useFakeTimers();
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(CLOSE_TIMEOUT_MS - 1);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(closed).toBe(true);
    // The stalled request is aborted, not left running.
    expect(server.aborted).toEqual(['DELETE']);
  });
});
