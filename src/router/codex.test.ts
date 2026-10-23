import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../context';
import { parseCodexHistory } from './codex-history';
import { codexRouterEvent, codexResponse } from './codex-event';
import { at, CODEX_PLUGIN, codexHookRows } from './codex-host';
import {
  codexAtLeast,
  runCodexDoctor,
  runCodexInstall,
  runCodexUninstall,
  type CodexRun,
  type CodexSetupDeps,
} from './codex-install';
import { runHookCommand } from './hook-command';
import { CODEX_ALLOW_HOOK_COMMAND } from './plugin-files';
import { runNativeHook, runPromptHook, runShortfallHook } from './hooks';
import { CODEX_REQUEST_TOOL, requestToolName } from './names';
import { resolveProgressSession, sessionDir } from './progress';

const session = 'session-one';
const meta = {
  type: 'session_meta',
  payload: { id: session, session_id: session, thread_source: 'user' },
};
const item = (id: string, text: string, type = 'UserMessage') => ({
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    thread_id: session,
    item: {
      id,
      type,
      phase: 'final_answer',
      content: [{ type: type === 'UserMessage' ? 'text' : 'Text', text }],
    },
  },
});
const history = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');
const native = {
  hook_event_name: 'PreToolUse',
  session_id: session,
  tool_name: 'webrun',
  tool_use_id: 'call-1',
  tool_input: { search_query: [{ q: 'example search' }] },
};
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const paidOffer = JSON.parse(
  readFileSync(join(fixtures, 'wire-hook-execute-spec.json'), 'utf8'),
) as { decision: { id: string } };
const nativeAnswer = {
  schemaVersion: 1,
  routerVersion: 'v',
  decision: {
    action: 'native',
    reason: 'Use native tools',
    diagnostics: {
      reasonCode: 'native_sufficient',
      stage: 'capability',
      missing: [],
      nextAction: 'Use native tools',
    },
  },
};

let dir: string;
let transcript: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-codex-'));
  await mkdir(join(dir, '.git'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ maxAutoSpend: '250000', sessionBudget: '5000000' }),
  );
  // A wallet for the offer to pay from: with none, a paid offer is withheld.
  await writeFile(
    join(dir, 'wallet.json'),
    JSON.stringify({ schemaVersion: 2, address: '0x1234567890AbcdEF1234567890aBcdef12345678' }),
  );
  transcript = join(dir, 'rollout.jsonl');
  await writeFile(transcript, history(meta, item('u', 'Find recent reports on example search.')));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A router stub that records each router body and answers `answer`. The
 * wallet's balance reads (JSON-RPC) share the fetch seam; they are not router
 * calls, so they are answered with a balance and left out of `bodies`.
 */
function router(answer: unknown) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.jsonrpc !== undefined) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0xf4240' }));
    }
    bodies.push(body);
    return new Response(JSON.stringify(answer));
  }) as typeof fetch;
  return { bodies, fetchImpl };
}

const codexDeps = (fetchImpl: typeof fetch) => ({
  dataDir: dir,
  harness: 'codex' as const,
  fetchImpl,
  prefetch: () => {},
});

describe('Codex transcript ownership and bounds', () => {
  it('admits completed conversation once, excluding synthetic and tool rows', () => {
    const user = item('u', 'No paid tools.');
    expect(
      parseCodexHistory(
        history(
          meta,
          {
            type: 'response_item',
            payload: { role: 'user', content: [{ type: 'input_text', text: 'injected' }] },
          },
          user,
          user,
          item('a', 'Understood.', 'AgentMessage'),
          item('t', 'untrusted', 'McpToolCall'),
        ),
        session,
      ),
    ).toEqual([
      { role: 'user', text: 'No paid tools.' },
      { role: 'assistant', text: 'Understood.' },
    ]);
  });

  it('rejects a child with copied parent metadata, mismatched items, empty history and compaction', () => {
    const child = {
      ...meta,
      payload: {
        ...meta.payload,
        id: 'child',
        thread_source: 'subagent',
        parent_thread_id: session,
      },
    };
    expect(parseCodexHistory(history(child, meta, item('u', 'secret')), session)).toBeNull();
    const other = item('u', 'secret');
    expect(
      parseCodexHistory(
        history(meta, { ...other, payload: { ...other.payload, thread_id: 'other' } }),
        session,
      ),
    ).toBeNull();
    expect(parseCodexHistory(history(meta), session)).toBeNull();
    expect(
      parseCodexHistory(
        history(meta, item('u', 'No paid tools'), { type: 'compacted', payload: {} }),
        session,
      ),
    ).toBeNull();
    expect(parseCodexHistory(history(meta, item('u', 'x')) + '\n{', session)).toBeNull();
  });

  it('never offers on a web call whose rollout is past the read bound', async () => {
    const big = item('u', 'x'.repeat(1_000_000));
    await writeFile(transcript, history(meta, big, big, big, big, item('u', 'Find it.')));
    const { bodies, fetchImpl } = router(paidOffer);
    const out = await runNativeHook(
      { ...native, cwd: dir, transcript_path: transcript },
      codexDeps(fetchImpl),
    );
    expect(out.response).toBeNull();
    expect(bodies).toHaveLength(0);
  });
});

describe('Codex web events', () => {
  /** Real `webrun` inputs from Codex 0.163 rollouts, the routed entry, and the exact rest. */
  const shapes: [string, Record<string, unknown>, unknown, Record<string, unknown> | undefined][] =
    [
      [
        'a lone search',
        { search_query: [{ q: 'example search' }] },
        { tool: 'WebSearch', query: 'example search' },
        undefined,
      ],
      [
        'a three-query batch, filter inside q',
        {
          search_query: [
            { q: 'best local LLM 16GB Mac' },
            { q: 'ollama qwen3 site:reddit.com' },
            { q: 'llama.cpp metal benchmarks' },
          ],
          response_length: 'medium',
        },
        { tool: 'WebSearch', query: 'best local LLM 16GB Mac' },
        {
          search_query: [
            { q: 'ollama qwen3 site:reddit.com' },
            { q: 'llama.cpp metal benchmarks' },
          ],
          response_length: 'medium',
        },
      ],
      [
        'a search plus an open',
        { search_query: [{ q: 'a' }], open: [{ ref_id: 'https://example.com/p' }] },
        { tool: 'WebSearch', query: 'a' },
        { open: [{ ref_id: 'https://example.com/p' }] },
      ],
      [
        'a domain-filtered search beside a plain one',
        {
          search_query: [{ q: 'a', domains: ['example.com'] }, { q: 'b', recency: 7 }, { q: 'c' }],
        },
        { tool: 'WebSearch', query: 'c' },
        {
          search_query: [
            { q: 'a', domains: ['example.com'] },
            { q: 'b', recency: 7 },
          ],
        },
      ],
      [
        'one URL open',
        { open: [{ ref_id: 'https://www.reddit.com/r/rust/comments/1dh773j/report/' }] },
        { tool: 'WebFetch', url: 'https://www.reddit.com/r/rust/comments/1dh773j/report/' },
        undefined,
      ],
      [
        'an open at a line, then a URL open',
        {
          open: [{ ref_id: 'https://a.example/x', lineno: 40 }, { ref_id: 'https://b.example/y' }],
        },
        { tool: 'WebFetch', url: 'https://b.example/y' },
        { open: [{ ref_id: 'https://a.example/x', lineno: 40 }] },
      ],
      [
        'an open at a line alone',
        { open: [{ ref_id: 'https://a.example/x', lineno: 40 }] },
        null,
        undefined,
      ],
      ['a turn-reference open', { open: [{ ref_id: 'turn0search0' }] }, null, undefined],
      ['a find only', { find: [{ ref_id: 'turn0view0', pattern: 'price' }] }, null, undefined],
      ['a click only', { click: [{ ref_id: 'turn0view0', id: 3 }] }, null, undefined],
      ['weather', { weather: [{ location: 'Toronto' }] }, null, undefined],
      [
        'a filtered search alone',
        { search_query: [{ q: 'a', domains: ['example.com'] }] },
        null,
        undefined,
      ],
    ];

  it.each(shapes)('reads %s as its entry and the exact rest', (_, tool_input, entry, rest) => {
    const event = codexRouterEvent({ ...native, tool_input });
    if (entry === null) {
      expect(event).toBeNull();
      return;
    }
    expect(event).toMatchObject({ kind: 'native', pending: entry });
    expect((event as { rest?: unknown }).rest).toEqual(rest);
  });

  it('keeps the daemon view: only a lone plain search is a web tool', () => {
    expect(codexRouterEvent(native)).toMatchObject({
      kind: 'native',
      pending: { tool: 'WebSearch', query: 'example search' },
    });
    expect(codexRouterEvent(native)).not.toHaveProperty('rest');
  });

  it('gives a child agent no routing: it has no request tool to call', () => {
    expect(codexRouterEvent({ ...native, agent_id: 'child' })).toBeNull();
    expect(
      codexRouterEvent({
        hook_event_name: 'UserPromptSubmit',
        session_id: session,
        agent_id: 'child',
        prompt: 'x',
      }),
    ).toBeNull();
  });

  it('reads a failed search from PostToolUse, and an unknown result as no shortfall', () => {
    const post = { ...native, hook_event_name: 'PostToolUse' };
    expect(
      codexRouterEvent({ ...post, tool_response: [{ type: 'input_text', text: 'native answer' }] }),
    ).toMatchObject({ kind: 'shortfall', nativeOutcome: null });
    expect(codexRouterEvent({ ...post, tool_response: '' })).toMatchObject({
      nativeOutcome: { error: 'Web search returned no results' },
    });
    // A batch returns one text for the whole call: only an empty one is short.
    const batchPost = { ...post, tool_input: { search_query: [{ q: 'a' }, { q: 'b' }] } };
    expect(codexRouterEvent({ ...batchPost, tool_response: '' })).toMatchObject({
      pending: { tool: 'WebSearch', query: 'a' },
      nativeOutcome: { error: 'Web search returned no results' },
    });
    expect(codexRouterEvent({ ...batchPost, tool_response: 'some results' })).toMatchObject({
      nativeOutcome: null,
    });
    expect(codexRouterEvent({ ...post, tool_response: { changed: 'schema' } })).toMatchObject({
      nativeOutcome: null,
      search: null,
    });
  });

  it('puts free docs beside the result, since Codex cannot replace it', () => {
    expect(
      codexResponse({ hookSpecificOutput: { updatedToolOutput: { results: ['free docs'] } } }),
    ).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'free docs' },
    });
    expect(
      codexResponse({ hookSpecificOutput: { hookEventName: 'PreToolUse' }, other: 1 }),
    ).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse' } });
  });

  it("keeps the user's line, alone or beside the hook's answer, in the field Codex shows", () => {
    expect(codexResponse({ systemMessage: 'routing fee not paid' })).toEqual({
      systemMessage: 'routing fee not paid',
    });
    expect(
      codexResponse({ hookSpecificOutput: { hookEventName: 'PreToolUse' }, systemMessage: 'x' }),
    ).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse' }, systemMessage: 'x' });
    expect(codexResponse({ systemMessage: 3 })).toBeNull();
  });
});

describe('Codex routing through the router', () => {
  it('denies a routed search with the Codex tool name and sends harness codex', async () => {
    const { bodies, fetchImpl } = router(paidOffer);
    const out = await runNativeHook(
      { ...native, cwd: dir, transcript_path: transcript },
      codexDeps(fetchImpl),
    );
    expect(at(out.response, 'hookSpecificOutput', 'permissionDecision')).toBe('deny');
    const reason = String(at(out.response, 'hookSpecificOutput', 'permissionDecisionReason'));
    expect(reason).toContain(`${CODEX_REQUEST_TOOL}({`);
    expect(reason).not.toContain('mcp__x402');
    expect(bodies[0]).toMatchObject({ harness: 'codex' });
    expect(at(bodies[0], 'packet', 'current', 'text')).toBe(
      'Find recent reports on example search.',
    );
    expect(at(bodies[0], 'packet', 'pendingCall')).toEqual({
      tool: 'WebSearch',
      query: 'example search',
    });
  });

  it('redirects one of two parallel copies of a search, and keeps Codex state apart from Claude', async () => {
    const { fetchImpl } = router(paidOffer);
    const event = { ...native, cwd: dir, transcript_path: transcript };
    const outs = await Promise.all([
      runNativeHook(event, codexDeps(fetchImpl)),
      runNativeHook({ ...event, tool_use_id: 'call-2' }, codexDeps(fetchImpl)),
    ]);
    expect(outs.filter((o) => o.response !== null)).toHaveLength(1);
    expect(await resolveProgressSession(dir, { id: paidOffer.decision.id })).toBe(
      sessionDir(dir, `codex:${session}`),
    );
  });

  it('delivers a prompt offer through the Codex envelope', async () => {
    const { bodies, fetchImpl } = router(paidOffer);
    const out = await runPromptHook(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: session,
        prompt: 'Research a topic',
        cwd: dir,
        transcript_path: transcript,
      },
      codexDeps(fetchImpl),
    );
    expect(at(out.response, 'hookSpecificOutput', 'hookEventName')).toBe('UserPromptSubmit');
    expect(String(at(out.response, 'hookSpecificOutput', 'additionalContext'))).toContain(
      `${CODEX_REQUEST_TOOL}({`,
    );
    expect(bodies[0]).toMatchObject({ harness: 'codex' });
  });

  it('says nothing when the router answers native', async () => {
    const { fetchImpl } = router(nativeAnswer);
    const out = await runNativeHook(
      { ...native, cwd: dir, transcript_path: transcript },
      codexDeps(fetchImpl),
    );
    expect(out.response).toBeNull();
  });

  it('offers on an empty search after it ran', async () => {
    const { fetchImpl } = router(paidOffer);
    const out = await runShortfallHook(
      {
        ...native,
        hook_event_name: 'PostToolUse',
        tool_use_id: 'call-9',
        tool_response: '',
        cwd: dir,
        transcript_path: transcript,
      },
      codexDeps(fetchImpl),
    );
    expect(at(out.response, 'hookSpecificOutput', 'hookEventName')).toBe('PostToolUse');
    expect(String(at(out.response, 'hookSpecificOutput', 'additionalContext'))).toContain(
      CODEX_REQUEST_TOOL,
    );
  });

  const batch = {
    search_query: [{ q: 'example search' }, { q: 'second search site:example.com' }],
    open: [{ ref_id: 'https://example.com/page', lineno: 12 }],
    response_length: 'short',
  };
  const rest = {
    search_query: [{ q: 'second search site:example.com' }],
    open: [{ ref_id: 'https://example.com/page', lineno: 12 }],
    response_length: 'short',
  };

  it('denies a batch once, naming the rest as exact JSON, and lets the re-run through', async () => {
    const { bodies, fetchImpl } = router(paidOffer);
    const event = { ...native, tool_input: batch, cwd: dir, transcript_path: transcript };
    const out = await runNativeHook(event, codexDeps(fetchImpl));
    expect(at(out.response, 'hookSpecificOutput', 'permissionDecision')).toBe('deny');
    const reason = String(at(out.response, 'hookSpecificOutput', 'permissionDecisionReason'));
    expect(reason).toContain(`${CODEX_REQUEST_TOOL}({`);
    expect(reason.endsWith(`call web.run again with exactly ${JSON.stringify(rest)}`)).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(at(bodies[0], 'packet', 'pendingCall')).toEqual({
      tool: 'WebSearch',
      query: 'example search',
    });
    // The rest, and the whole call again, run with no second router call.
    const routerCalls = bodies.length;
    for (const [id, tool_input] of [
      ['call-rest', rest],
      ['call-again', batch],
    ] as const) {
      const again = await runNativeHook(
        { ...event, tool_use_id: id, tool_input },
        codexDeps(fetchImpl),
      );
      expect(again.response).toBeNull();
    }
    expect(bodies.length).toBe(routerCalls);
  });

  it('routes a lone URL open as WebFetch, and runs a batch untouched on a free or no offer', async () => {
    const page = 'https://www.reddit.com/r/rust/comments/1dh773j/report/';
    const paid = router(paidOffer);
    const out = await runNativeHook(
      {
        ...native,
        tool_input: { open: [{ ref_id: page }] },
        cwd: dir,
        transcript_path: transcript,
      },
      codexDeps(paid.fetchImpl),
    );
    expect(at(out.response, 'hookSpecificOutput', 'permissionDecision')).toBe('deny');
    expect(at(paid.bodies[0], 'packet', 'pendingCall')).toEqual({ tool: 'WebFetch', url: page });
    const freeOffer = {
      ...paidOffer,
      decision: { ...paidOffer.decision, providerPriceAtomic: '0' },
    };
    for (const answer of [freeOffer, nativeAnswer]) {
      const { fetchImpl } = router(answer);
      const ran = await runNativeHook(
        {
          ...native,
          tool_use_id: `call-${String(answer === nativeAnswer)}`,
          tool_input: { ...batch, search_query: [{ q: 'fresh search' }, ...rest.search_query] },
          cwd: dir,
          transcript_path: transcript,
        },
        codexDeps(fetchImpl),
      );
      expect(ran.response).toBeNull();
    }
  });

  /** One hook command run, its stdout captured. */
  async function hookRun(kind: 'prompt' | 'native', event: unknown, extra: object = {}) {
    const writes: string[] = [];
    const io = {
      stdout: { write: (s: string) => (writes.push(s), true) } as unknown as NodeJS.WritableStream,
      stderr: process.stderr,
      isTTY: false,
    };
    const { fetchImpl } = router(paidOffer);
    await runHookCommand(kind, io, {
      dataDir: dir,
      harness: 'codex',
      readEvent: async () => JSON.stringify(event),
      fetchImpl,
      ...extra,
    });
    return writes.length === 0 ? null : (JSON.parse(writes[0]!) as unknown);
  }
  // Built per test: `dir` and `transcript` are set in beforeEach.
  const promptEvent = () => ({
    hook_event_name: 'UserPromptSubmit',
    session_id: session,
    prompt: 'Research a topic',
    cwd: dir,
  });
  const webEvent = () => ({ ...native, cwd: dir, transcript_path: transcript });

  it('always denies a routed search, with no prompt leg first and no record kept', async () => {
    const out = await hookRun('native', webEvent());
    expect(at(out, 'hookSpecificOutput', 'permissionDecision')).toBe('deny');
    expect(String(at(out, 'hookSpecificOutput', 'permissionDecisionReason'))).toContain(
      `${CODEX_REQUEST_TOOL}({`,
    );
    expect(await hookRun('prompt', promptEvent())).not.toBeNull();
    expect(existsSync(join(sessionDir(dir, `codex:${session}`), 'request-tool.json'))).toBe(false);
  });

  it('denies a search once, so a retry of it runs even where Codex refuses the tool', async () => {
    const first = await hookRun('native', webEvent());
    expect(at(first, 'hookSpecificOutput', 'permissionDecision')).toBe('deny');
    const retry = await hookRun('native', { ...webEvent(), tool_use_id: 'call-retry' });
    expect(at(retry, 'hookSpecificOutput', 'permissionDecision')).toBeUndefined();
  });

  it('names the request tool by host', () => {
    expect(requestToolName('codex')).toBe('mcp__router__request');
  });
});

const ctx = (): CommandContext => ({
  dataDir: dir,
  flags: { json: true, timeout: 1000 },
  io: { stdout: process.stdout, stderr: process.stderr, isTTY: false },
});

/** A Codex stand-in: records every command in order. */
function host(config: unknown = {}) {
  const steps: string[] = [];
  const deps: CodexSetupDeps = {
    run: async (args: string[]): Promise<CodexRun> => {
      steps.push(`codex ${args.filter((a) => a !== '--json').join(' ')}`);
      return { code: 0, stdout: '{}', stderr: '' };
    },
    config: async () => config,
    hooks: async () => ({ data: [] }),
    version: async () => '0.157.1',
    hostsDir: '/package/dist/hosts/codex',
    walletExists: async () => false,
    createWallet: async () => {
      steps.push('wallet');
      return '0x1111111111111111111111111111111111111111';
    },
  };
  return { steps, deps };
}

/** One `hooks/list` row of the Tenjin plugin, as Codex's HookMetadata carries it. */
const row = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  pluginId: CODEX_PLUGIN,
  enabled: true,
  trustStatus: 'trusted',
  ...over,
});
const allowRow = (over: Record<string, unknown> = {}) =>
  row('/c/tenjin/hooks/hooks.json:permission_request:0:0', {
    command: CODEX_ALLOW_HOOK_COMMAND,
    ...over,
  });
const listed = (...rows: unknown[]) => ({
  data: [{ hooks: [{ key: 'theirs', pluginId: 'other@x', trustStatus: 'untrusted' }, ...rows] }],
});
/** A routing leg as Codex 0.157 lists it: an `mcp_tool` hook into the plugin's server. */
const legRow = (key: string, over: Record<string, unknown> = {}) =>
  row(key, { handlerType: 'mcpTool', server: 'router', tool: 'hook', ...over });
const allRows = () => [legRow('a'), legRow('b'), legRow('c'), row('deny'), allowRow()];

describe('Codex install, uninstall and doctor', () => {
  it('writes the wallet, the spend limits and the plugin, and no Codex config', async () => {
    const { steps, deps } = host();
    const out = await runCodexInstall({ yes: true }, ctx(), deps);
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as object;
    expect(config).toMatchObject({ maxAutoSpend: '250000' });
    expect(steps).toEqual([
      'wallet',
      'codex plugin marketplace add /package/dist/hosts/codex',
      'codex plugin add tenjin@tenjin',
    ]);
    expect(out.data).not.toHaveProperty('grant');
    expect(out.data).not.toHaveProperty('approval');
    expect(out.humanLines?.join('\n')).toContain('five Tenjin hooks');
  });

  it('keeps the defaults with no answer and hands the spend question back', async () => {
    await writeFile(join(dir, 'config.json'), '{}');
    const { deps } = host();
    const out = await runCodexInstall({}, ctx(), deps);
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as object;
    expect(config).not.toHaveProperty('maxAutoSpend');
    expect(config).not.toHaveProperty('sessionBudget');
    const data = out.data as {
      spend: { effective: { maxAutoSpend: string; sessionBudget: string } };
      nextSteps: { id: string; options: { command: string | null }[] }[];
    };
    expect(data.spend.effective).toEqual({ maxAutoSpend: '0.25', sessionBudget: '5' });
    expect(data.nextSteps.map((s) => s.id)).toEqual(['spend']);
    expect(data.nextSteps[0]?.options.map((o) => o.command)).toEqual([
      'tenjin install --yes',
      'tenjin install --max-auto-spend <usd> --session-budget <usd|none>',
    ]);
    expect(out.data).not.toHaveProperty('approval');
  });

  it('asks nothing again once the file names a limit', async () => {
    const { deps } = host();
    const out = await runCodexInstall({}, ctx(), deps);
    expect((out.data as { nextSteps: unknown[] }).nextSteps).toEqual([]);
  });

  it('writes the limits the two flags name, and asks nothing', async () => {
    await writeFile(join(dir, 'config.json'), '{}');
    const { deps } = host();
    const out = await runCodexInstall({ maxAutoSpend: '0.5', sessionBudget: 'none' }, ctx(), deps);
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as object;
    expect(config).toMatchObject({ maxAutoSpend: '500000', sessionBudget: 'none' });
    expect((out.data as { nextSteps: unknown[] }).nextSteps).toEqual([]);
  });

  it('refuses a per-call limit under the 0.25 floor before any write', async () => {
    await writeFile(join(dir, 'config.json'), '{}');
    const { steps, deps } = host();
    await expect(runCodexInstall({ maxAutoSpend: '0.1' }, ctx(), deps)).rejects.toThrow(
      '--max-auto-spend 0.1',
    );
    expect(steps).toEqual([]);
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('{}');
  });

  it('refuses project scope before any write', async () => {
    const { steps, deps } = host();
    await expect(runCodexInstall({ project: true }, ctx(), deps)).rejects.toThrow('user only');
    expect(steps).toEqual([]);
  });

  it('removes the plugin and its marketplace, reading no config first', async () => {
    const { steps, deps } = host(null);
    const out = await runCodexUninstall({}, ctx(), deps);
    expect(steps).toEqual([
      'codex plugin remove tenjin@tenjin',
      'codex plugin marketplace remove tenjin',
    ]);
    expect(out.data).toEqual({ removed: CODEX_PLUGIN, marketplace: 'tenjin' });
  });

  it('reads the plugin from hooks/list rows: installed and trusted, absent, untrusted', () => {
    expect(codexHookRows(listed(...allRows()))).toEqual({
      state: 'trusted',
      allowOff: false,
      routing: 'paid',
    });
    expect(codexHookRows(listed())).toEqual({
      state: 'absent',
      allowOff: false,
      routing: 'unknown',
    });
    expect(codexHookRows(listed(row('a'), row('b', { trustStatus: 'untrusted' })))).toMatchObject({
      state: 'review',
    });
    expect(
      codexHookRows(
        listed(legRow('a'), legRow('b'), legRow('c', { enabled: false }), row('d'), allowRow()),
      ),
    ).toMatchObject({ state: 'review' });
    expect(codexHookRows(listed(row('a'), row('b'), row('c')))).toMatchObject({ state: 'review' });
    expect(codexHookRows(null)).toEqual({ state: 'unknown', allowOff: false, routing: 'unknown' });
    // The allow hook off is the documented opt-out, so the plugin still counts as ready.
    expect(
      codexHookRows(
        listed(
          legRow('a'),
          legRow('b'),
          legRow('c'),
          row('d'),
          allowRow({ enabled: false, trustStatus: 'untrusted' }),
        ),
      ),
    ).toEqual({ state: 'trusted', allowOff: true, routing: 'paid' });
  });

  it('tells command legs from an older build apart from the legs that pay the fee', () => {
    const command = (kind: string) =>
      row(kind, { handlerType: 'command', command: `tenjin hook ${kind} --harness codex` });
    expect(
      codexHookRows(listed(command('prompt'), command('native'), command('shortfall'), allowRow())),
    ).toMatchObject({ routing: 'free' });
    expect(codexHookRows(listed(legRow('a'), allowRow()))).toMatchObject({ routing: 'unknown' });
  });

  it('fails on command legs and on a Codex too old for mcp_tool hooks, and never pays', async () => {
    const command = (kind: string) =>
      row(kind, { handlerType: 'command', command: `tenjin hook ${kind} --harness codex` });
    const stale = [
      command('prompt'),
      command('native'),
      command('shortfall'),
      row('d'),
      allowRow(),
    ];
    const { steps, deps } = host();
    await expect(
      runCodexDoctor({}, ctx(), { ...deps, hooks: async () => listed(...stale) }),
    ).rejects.toMatchObject({
      details: { routing: 'free', ok: false },
      fix: expect.stringContaining('cannot pay the routing fee'),
    });
    await expect(
      runCodexDoctor({}, ctx(), {
        ...deps,
        hooks: async () => listed(...allRows()),
        version: async () => '0.147.0',
      }),
    ).rejects.toMatchObject({
      details: { routing: 'paid', version: '0.147.0', ok: false },
      fix: expect.stringContaining('Update Codex to 0.148.0 or later'),
    });
    // Nothing ran: no codex command, and the only reads are the stand-ins above.
    expect(steps).toEqual([]);
  });

  it('compares Codex builds by number, a suffix ignored', () => {
    expect(codexAtLeast('0.157.1', '0.148.0')).toBe(true);
    expect(codexAtLeast('0.148.0', '0.148.0')).toBe(true);
    expect(codexAtLeast('0.148.0-alpha.2', '0.148.0')).toBe(true);
    expect(codexAtLeast('0.147.9', '0.148.0')).toBe(false);
    expect(codexAtLeast('1.0.0', '0.148.0')).toBe(true);
  });

  it('reads one hooks/list, runs no codex command, and never calls the build a gate', async () => {
    const { steps, deps } = host({ approval_policy: 'never' });
    const ready = await runCodexDoctor({}, ctx(), {
      ...deps,
      hooks: async () => listed(...allRows()),
    });
    expect(steps).toEqual([]);
    expect(ready.data).toMatchObject({
      hooks: 'trusted',
      ok: true,
      version: '0.157.1',
    });
    expect(ready.data).not.toHaveProperty('elicitation');
    expect(ready.humanLines?.join('\n')).toContain('information only');
    expect(ready.humanLines?.join('\n')).not.toContain('Pay once');
  });

  it('fails with the install step when absent and the /hooks step when untrusted', async () => {
    const { deps } = host();
    await expect(runCodexDoctor({}, ctx(), deps)).rejects.toMatchObject({
      code: 'REFUSED',
      details: { hooks: 'absent', ok: false },
      fix: expect.stringContaining('tenjin install --harness codex'),
    });
    await expect(
      runCodexDoctor({}, ctx(), {
        ...deps,
        hooks: async () => listed(...allRows().map((r) => ({ ...r, trustStatus: 'untrusted' }))),
      }),
    ).rejects.toMatchObject({
      details: { hooks: 'review' },
      fix: expect.stringContaining('/hooks'),
    });
  });

  it('fails when the allow hook is off under approval_policy never, which refuses the tool', async () => {
    const off = () =>
      listed(legRow('a'), legRow('b'), legRow('c'), row('d'), allowRow({ enabled: false }));
    const prompt = await runCodexDoctor({}, ctx(), { ...host().deps, hooks: async () => off() });
    expect(prompt.humanLines?.join('\n')).toContain('asks before each call');
    await expect(
      runCodexDoctor({}, ctx(), {
        ...host({ approval_policy: 'never' }).deps,
        hooks: async () => off(),
      }),
    ).rejects.toMatchObject({ details: { allowOff: true, ok: false } });
  });
});
