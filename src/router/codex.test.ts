import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCodexHistory } from './codex-history';
import { codexRouterEvent, codexResponse } from './codex-event';
import { runHookCommand } from './hook-command';
import { runNativeHook, runPromptHook } from './hooks';
import { at, requestConfigured, CODEX_PLUGIN } from './codex-host';
import { runCodexSetup } from './codex-install';
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
const configured = {
  plugins: {
    [CODEX_PLUGIN]: {
      enabled: true,
      mcp_servers: { x402: { tools: { request: { approval_mode: 'approve' } } } },
    },
  },
};
const native = {
  hook_event_name: 'PreToolUse',
  session_id: session,
  tool_name: 'webrun',
  tool_use_id: 'call-1',
  tool_input: { search_query: [{ q: 'example search' }] },
};
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-codex-'));
  await mkdir(join(dir, '.git'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ maxAutoSpend: '250000', sessionBudget: '5000000', confirm: 'above:250000' }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Codex transcript ownership and constraints', () => {
  it('admits completed conversation once, excluding synthetic/tool rows', () => {
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
    expect(
      parseCodexHistory(
        history(
          {
            ...meta,
            payload: {
              ...meta.payload,
              id: 'child',
              thread_source: 'subagent',
              parent_thread_id: session,
            },
          },
          meta,
          item('u', 'secret'),
        ),
        session,
      ),
    ).toBeNull();
    expect(
      parseCodexHistory(
        history(meta, {
          ...item('u', 'secret'),
          payload: { ...item('u', 'secret').payload, thread_id: 'other' },
        }),
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
});

describe('conservative web routing', () => {
  it('maps only the entire qualified unfiltered single search', () => {
    expect(codexRouterEvent(native, true)).toMatchObject({
      kind: 'native',
      pending: { tool: 'WebSearch', query: 'example search' },
    });
    for (const tool_input of [
      { search_query: [{ q: 'a' }, { q: 'b' }] },
      { search_query: [{ q: 'a', domains: ['example.com'] }] },
      { search_query: [{ q: 'a' }], open: [{ ref_id: 'https://example.com' }] },
      { search_query: [{ q: 'a' }], find: [] },
    ])
      expect(codexRouterEvent({ ...native, tool_input }, true)).toBeNull();
    expect(codexRouterEvent(native, false)).toBeNull();
    expect(codexRouterEvent({ ...native, agent_id: 'child' }, true)).toBeNull();
  });
  it('keeps post result unknown unless the decoded result is actually empty', () => {
    const post = { ...native, hook_event_name: 'PostToolUse' };
    expect(
      codexRouterEvent(
        { ...post, tool_response: [{ type: 'input_text', text: 'native answer' }] },
        true,
      ),
    ).toMatchObject({ nativeOutcome: null });
    expect(codexRouterEvent({ ...post, tool_response: { changed: 'schema' } }, true)).toMatchObject(
      { nativeOutcome: null, search: null },
    );
    expect(
      codexResponse({ hookSpecificOutput: { updatedToolOutput: { results: ['free docs'] } } }),
    ).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'free docs' },
    });
  });
  it('passes prior user constraints to the existing native gate without changing wire fields', async () => {
    const path = join(dir, 'rollout.jsonl');
    await writeFile(
      path,
      history(
        meta,
        item('u', 'No paid tools. Read the brief.'),
        item('a', 'Reading it', 'AgentMessage'),
      ),
    );
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
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
        }),
      );
    }) as typeof fetch;
    const result = await runNativeHook(
      { ...native, cwd: dir, transcript_path: path },
      { dataDir: dir, harness: 'codex', codexWebReady: true, fetchImpl },
    );
    expect(result.response).toBeNull();
    expect(bodies).toHaveLength(1);
    expect(at(bodies[0], 'packet', 'current', 'text')).toBe('No paid tools. Read the brief.');
    expect(at(bodies[0], 'packet', 'pendingCall')).toEqual({
      tool: 'WebSearch',
      query: 'example search',
    });
    expect(Object.keys(bodies[0] as object).sort()).toEqual(['packet', 'schemaVersion']);
  });
  it('delivers a real router offer through the Codex prompt envelope and isolates progress', async () => {
    const offer = {
      schemaVersion: 1,
      routerVersion: 'v',
      decision: {
        action: 'execute',
        id: 'codex-offer',
        capabilityId: 'lookup',
        category: 'search',
        provider: 'Example',
        capabilityDescription: 'search',
        endpoint: 'https://example.com/search',
        providerPriceAtomic: '1000',
        usage: 'query',
        hint: 'Call request({query: "a", id: "codex-offer"})',
      },
    };
    const out = await runPromptHook(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: session,
        prompt: 'Research a topic',
        cwd: dir,
      },
      {
        dataDir: dir,
        harness: 'codex',
        fetchImpl: (async () => new Response(JSON.stringify(offer))) as typeof fetch,
      },
    );
    expect(at(out.response, 'hookSpecificOutput', 'additionalContext')).toContain(
      'mcp__x402__request',
    );
    expect(await resolveProgressSession(dir, { id: 'codex-offer' })).toBe(
      sessionDir(dir, `codex:${session}`),
    );
  });
  it('never emits an offer when the host grant is unavailable', async () => {
    const writes: string[] = [];
    await runHookCommand(
      'prompt',
      {
        stdout: {
          write: (s: string) => {
            writes.push(s);
            return true;
          },
        } as NodeJS.WritableStream,
        stderr: process.stderr,
        isTTY: false,
      },
      {
        dataDir: dir,
        harness: 'codex',
        readEvent: async () =>
          JSON.stringify({
            hook_event_name: 'UserPromptSubmit',
            session_id: session,
            prompt: 'search',
          }),
        codexReadiness: async () => ({ prompt: false, web: false }),
        fetchImpl: (async () => {
          throw new Error('must not call');
        }) as typeof fetch,
      },
    );
    expect(writes).toEqual([]);
  });
});

describe('plugin setup and diagnostics', () => {
  it('requires the plugin-owned exact grant and refuses conflicting direct transport', () => {
    expect(requestConfigured(configured)).toBe(true);
    expect(requestConfigured({ plugins: { [CODEX_PLUGIN]: { enabled: true } } })).toBe(false);
    expect(requestConfigured({ ...configured, mcp_servers: { x402: {} } })).toBe(false);
  });
  const ctx = () => ({
    dataDir: dir,
    flags: { json: true, timeout: 1000 },
    io: { stdout: process.stdout, stderr: process.stderr, isTTY: false },
  });
  it('delegates install/removal to the host without Claude setup or broad grants', async () => {
    const calls: string[][] = [];
    const deps = {
      run: async (a: string[]) => {
        calls.push(a);
        return '{}';
      },
      config: async () => configured,
      version: async () => '0.154.0',
      hooks: async () => ({ data: [] }),
      packageRoot: '/package',
    };
    await runCodexSetup('install', { noWallet: true }, ctx(), deps);
    expect(calls).toEqual([
      ['plugin', 'marketplace', 'add', '/package', '--json'],
      ['plugin', 'add', CODEX_PLUGIN, '--json'],
    ]);
    await runCodexSetup('uninstall', {}, ctx(), deps);
    expect(calls.at(-1)).toEqual(['plugin', 'remove', CODEX_PLUGIN, '--json']);
  });
  it('reports unknown versions and trust as unverified, never full readiness', async () => {
    await expect(
      runCodexSetup('doctor', {}, ctx(), {
        config: async () => configured,
        version: async () => '0.157.1',
        hooks: async () => ({ data: [] }),
      }),
    ).rejects.toMatchObject({
      code: 'REFUSED',
      details: {
        configured: true,
        trusted: false,
        webVerified: false,
        fullReadinessVerified: false,
      },
    });
  });
  it('refuses project scope before any user-wide mutation', async () => {
    await expect(
      runCodexSetup('install', { project: true }, ctx(), {
        run: async () => {
          throw new Error('must not run');
        },
      }),
    ).rejects.toThrow('user scope');
  });
});
