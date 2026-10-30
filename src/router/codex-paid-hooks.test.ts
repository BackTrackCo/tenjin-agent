import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readSpendSummary } from '../lib/wallet/spend';
import { FakeRouter, testSigner } from './fee-test-utils';
import { runHookCommand, STALE_HOOK_LINE } from './hook-command';
import { createRouterMcpServer } from './mcp';
import { renderProgress } from './progress';
import type { RoutingPayerDeps } from './routing-payer';

/**
 * CODEX'S AUTOMATIC HOOKS ON THE PAID PATH (tenjin-agent#502). Each test reads
 * the checked-in Codex `hooks.json`, expands a leg's `input` the way Codex
 * 0.157 does, and calls the `hook` tool of the server `tenjin mcp --harness
 * codex` runs, built by the production factory with its production payer
 * wiring: the spend policy, the ledger and the channel storage are real, and
 * only the network (the router, the chain reads) and the wallet signer are
 * fakes. No money moves.
 */

const BASE = 'https://router.test';
const SESSION = '01a1658a-1223-73f1-91f9-62ecb164c700';
const HOOKS = fileURLToPath(new URL('../../hosts/codex/tenjin/hooks/hooks.json', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const wallet = privateKeyToAccount(generatePrivateKey());

let dir: string;
let homeDir: string;
let transcript: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-codex-paid-'));
  await mkdir(join(dir, '.git'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ maxAutoSpend: '250000', sessionBudget: '5000000' }),
  );
  homeDir = join(dir, 'home');
  const day = join(homeDir, '.codex', 'sessions', '2026', '10', '22');
  await mkdir(day, { recursive: true });
  transcript = join(day, `rollout-2026-10-22T17-35-09-${SESSION}.jsonl`);
  const row = (id: string, text: string) => ({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: SESSION,
      item: { id, type: 'UserMessage', phase: 'final_answer', content: [{ type: 'text', text }] },
    },
  });
  await writeFile(
    transcript,
    [
      {
        type: 'session_meta',
        payload: { id: SESSION, session_id: SESSION, thread_source: 'user' },
      },
      row('u', 'Find recent reports on example search.'),
    ]
      .map((r) => JSON.stringify(r))
      .join('\n'),
  );
  homeDir = await realpath(homeDir);
  transcript = await realpath(transcript);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The one handler a Codex event runs from the checked-in plugin, for `matcher`. */
async function handler(event: string, matcher?: string): Promise<Record<string, unknown>> {
  const file = JSON.parse(await readFile(HOOKS, 'utf8')) as {
    hooks: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]>;
  };
  const groups = file.hooks[event]!.filter((g) => g.matcher === matcher);
  expect(groups).toHaveLength(1);
  return groups[0]!.hooks[0]!;
}

/**
 * Codex's `expand_mcp_argument_template` (openai/codex
 * `hooks/src/engine/mcp_runner.rs`): a whole `${path}` keeps the field's JSON
 * type, and a field the event lacks fails the hook.
 */
function expand(template: Record<string, unknown>, event: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(template).map(([key, value]) => {
      const path = typeof value === 'string' ? /^\$\{([^{}]+)\}$/.exec(value)?.[1] : undefined;
      if (path === undefined) return [key, value];
      if (!(path in event)) throw new Error(`hook input placeholder \${${path}} was not found`);
      return [key, event[path]];
    }),
  );
}

/** What Codex 0.157 writes for each event: every field its schema requires. */
function codexEvent(kind: 'prompt' | 'native', over: Record<string, unknown> = {}) {
  const common = {
    session_id: SESSION,
    turn_id: 'turn-1',
    transcript_path: transcript,
    cwd: dir,
    model: 'gpt-5.5',
    permission_mode: 'default',
  };
  return kind === 'prompt'
    ? {
        ...common,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'what is the current price of ETH in USD',
        ...over,
      }
    : {
        ...common,
        hook_event_name: 'PreToolUse',
        tool_name: 'webrun',
        tool_use_id: 'call-1',
        tool_input: { search_query: [{ q: 'example search' }] },
        ...over,
      };
}

/** The production server with only the network and the signer faked. */
async function connect(fake: FakeRouter, payer: Partial<RoutingPayerDeps> = {}) {
  const fetchImpl = fake.fetch;
  const server = await createRouterMcpServer({
    dataDir: dir,
    harness: 'codex',
    homeDir,
    flags: { baseUrl: BASE },
    payerDeps: {
      getSigner: async () => testSigner(wallet),
      fetchImpl,
      readContract: fake.readContract as never,
      walletBalance: async () => 10_000_000n,
      warn: () => undefined,
      ...payer,
    },
    hookDeps: { fetchImpl, warn: () => undefined },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'codex-mcp-client', version: '0.157.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    /** One Codex hook run: the leg's server, tool and expanded input, and its thread. */
    run: async (
      leg: Record<string, unknown>,
      event: Record<string, unknown>,
      threadId = SESSION,
    ) => {
      expect(leg).toMatchObject({ type: 'mcp_tool', server: 'router', tool: 'hook' });
      const called = await client.callTool({
        name: String(leg['tool']),
        arguments: expand(leg['input'] as Record<string, unknown>, event),
        _meta: { threadId },
      });
      const text = (called.content as { text: string }[])[0]!.text;
      return text === '' ? null : (JSON.parse(text) as Record<string, unknown>);
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function offer(): Promise<unknown> {
  return JSON.parse(await readFile(join(fixtures, 'wire-hook-execute-spec.json'), 'utf8'));
}

describe('Codex automatic hooks', () => {
  it('pay the routing fee in the router MCP server and inject its offer', async () => {
    const fake = new FakeRouter();
    fake.body = await offer();
    const server = await connect(fake);
    try {
      const prompt = await server.run(await handler('UserPromptSubmit'), codexEvent('prompt'));
      expect(prompt).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: expect.stringContaining('mcp__router__request'),
        },
        systemMessage: expect.stringContaining('set aside $0.25 for routing'),
      });
      const native = await server.run(await handler('PreToolUse', 'webrun'), codexEvent('native'));
      expect(native).toMatchObject({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
      });
      // Every call went to the paid route: one deposit, then a voucher.
      expect(fake.log).toEqual([
        'POST /api/x402-router/route unpaid',
        'POST /api/x402-router/route paid',
        'POST /api/x402-router/route unpaid',
        'POST /api/x402-router/route paid',
      ]);
      expect(fake.deposits).toBe(1);
      // The deposit counts against the daily budget, as an MCP lookup's does.
      expect((await readSpendSummary(dir))?.committedAtomic).toBe('250000');
    } finally {
      await server.close();
    }
  });

  it('show the real reason when the fee cannot be paid, and record it as unpaid', async () => {
    const fake = new FakeRouter();
    fake.body = await offer();
    const server = await connect(fake, { walletBalance: async () => 20_000n });
    try {
      const out = await server.run(await handler('UserPromptSubmit'), codexEvent('prompt'));
      expect(out).toEqual({ systemMessage: expect.stringContaining('could not pay') });
      expect(fake.log).toEqual(['POST /api/x402-router/route unpaid']);
      expect(out?.systemMessage).toContain('Your usual tools still work.');
      expect(out?.systemMessage).not.toContain('tenjin wallet fund');
      expect(fake.paidRequests()).toBe(0);
      expect(await renderProgress(dir, `codex:${SESSION}`, { columns: 200 })).toContain(
        'prompt: fee unpaid: wallet_low',
      );
    } finally {
      await server.close();
    }
  });

  it("say nothing, and send nothing, for a subagent's leg or a forged transcript", async () => {
    const fake = new FakeRouter();
    fake.body = await offer();
    const server = await connect(fake);
    try {
      const leg = await handler('UserPromptSubmit');
      expect(await server.run(leg, codexEvent('prompt'), 'child-thread')).toBeNull();
      const forged = join(dir, `rollout-2026-10-22T17-35-09-${SESSION}.jsonl`);
      await writeFile(forged, '');
      expect(await server.run(leg, codexEvent('prompt', { transcript_path: forged }))).toBeNull();
      expect(fake.log).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('route on the leg alone when Codex records no transcript', async () => {
    const fake = new FakeRouter();
    fake.body = await offer();
    const server = await connect(fake);
    try {
      const out = await server.run(
        await handler('UserPromptSubmit'),
        codexEvent('prompt', { transcript_path: null }),
      );
      expect(out).toMatchObject({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
      expect(fake.paidRequests()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('name only fields Codex always sends, so no leg fails on a missing one', async () => {
    const after = await handler('PostToolUse', 'webrun');
    const event = { ...codexEvent('native'), hook_event_name: 'PostToolUse', tool_response: '' };
    for (const leg of [
      [await handler('UserPromptSubmit'), codexEvent('prompt')],
      [await handler('PreToolUse', 'webrun'), codexEvent('native')],
      [after, event],
    ] as const) {
      expect(() => expand(leg[0]['input'] as Record<string, unknown>, leg[1])).not.toThrow();
      expect(Object.values(leg[0]['input'] as object)).not.toContain('${agent_id}');
    }
  });
});

describe('a Codex plugin copy from an older build', () => {
  it('tells the user once to set Tenjin up again, in the field Codex shows, and routes nothing', async () => {
    const run = async () => {
      let out = '';
      await runHookCommand({ stdout: { write: (s: string) => ((out += s), true) } } as never, {
        dataDir: dir,
        harness: 'codex',
        readEvent: async () => JSON.stringify(codexEvent('prompt')),
      });
      return out;
    };
    expect(JSON.parse(await run())).toEqual({ systemMessage: STALE_HOOK_LINE });
    expect(await run()).toBe('');
  });
});
