import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../context';
import { parseCodexHistory } from './codex-history';
import { codexRouterEvent, codexResponse } from './codex-event';
import { at, CODEX_GRANT, CODEX_PLUGIN, requestConfigured } from './codex-host';
import {
  elicitationCanShow,
  hookTrust,
  runCodexDoctor,
  runCodexInstall,
  runCodexUninstall,
  type CodexRun,
  type CodexSetupDeps,
} from './codex-install';
import { runHookCommand } from './hook-command';
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
const granted = {
  plugins: {
    [CODEX_PLUGIN]: {
      enabled: true,
      mcp_servers: { router: { tools: { request: { approval_mode: 'approve' } } } },
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
  transcript = join(dir, 'rollout.jsonl');
  await writeFile(transcript, history(meta, item('u', 'Find recent reports on example search.')));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A router stub that records each body and answers `answer`. */
function router(answer: unknown) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
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
  it('maps only one complete, unfiltered search, and passes batches and mixed calls through', () => {
    expect(codexRouterEvent(native)).toMatchObject({
      kind: 'native',
      pending: { tool: 'WebSearch', query: 'example search' },
    });
    for (const tool_input of [
      { search_query: [{ q: 'a' }, { q: 'b' }] },
      { search_query: [{ q: 'a', domains: ['example.com'] }] },
      { search_query: [{ q: 'a' }], open: [{ ref_id: 'https://example.com' }] },
      { search_query: [{ q: 'a' }], find: [] },
    ])
      expect(codexRouterEvent({ ...native, tool_input })).toBeNull();
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
      codexResponse({ hookSpecificOutput: { hookEventName: 'PreToolUse' }, systemMessage: 'x' }),
    ).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse' } });
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

  it('stays silent without the request grant, as approval_policy never would refuse the call', async () => {
    const writes: string[] = [];
    const io = {
      stdout: { write: (s: string) => (writes.push(s), true) } as unknown as NodeJS.WritableStream,
      stderr: process.stderr,
      isTTY: false,
    };
    const prompt = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: session,
      prompt: 'Research a topic',
      cwd: dir,
    });
    await runHookCommand('prompt', io, {
      dataDir: dir,
      harness: 'codex',
      readEvent: async () => prompt,
      codexReady: async () => false,
      fetchImpl: (async () => {
        throw new Error('must not call the router');
      }) as typeof fetch,
    });
    expect(writes).toEqual([]);
    const { fetchImpl } = router(paidOffer);
    await runHookCommand('prompt', io, {
      dataDir: dir,
      harness: 'codex',
      readEvent: async () => prompt,
      codexReady: async () => true,
      fetchImpl,
    });
    expect(writes).toHaveLength(1);
  });

  it('names the request tool by host', () => {
    expect(requestToolName('codex')).toBe('mcp__router__request');
    expect(CODEX_GRANT).toBe(
      'plugins."tenjin@tenjin".mcp_servers.router.tools.request.approval_mode',
    );
  });
});

const ctx = (): CommandContext => ({
  dataDir: dir,
  flags: { json: true, timeout: 1000 },
  io: { stdout: process.stdout, stderr: process.stderr, isTTY: false },
});

/** A Codex stand-in: records every command and grant write in order. */
function host(config: unknown = {}) {
  const steps: string[] = [];
  const deps: CodexSetupDeps = {
    run: async (args: string[]): Promise<CodexRun> => {
      steps.push(`codex ${args.filter((a) => a !== '--json').join(' ')}`);
      return { code: 0, stdout: '{"installed":[]}', stderr: '' };
    },
    config: async () => config,
    writeGrant: async (value) => {
      steps.push(`grant ${String(value)}`);
      return true;
    },
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

describe('Codex install, uninstall and doctor', () => {
  it('writes the wallet, the spend limits, the plugin and then the grant', async () => {
    const { steps, deps } = host();
    const out = await runCodexInstall({ yes: true }, ctx(), deps);
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as object;
    expect(config).toMatchObject({ maxAutoSpend: '250000' });
    expect(steps).toEqual([
      'wallet',
      'codex plugin marketplace add /package/dist/hosts/codex',
      'codex plugin add tenjin@tenjin',
      'grant approve',
    ]);
    expect(out.data).toMatchObject({ grant: 'approved' });
  });

  it("asks before the grant where nobody consented, and never writes over the user's own value", async () => {
    const pending = host();
    const out = await runCodexInstall({}, ctx(), pending.deps);
    expect(pending.steps).not.toContain('grant approve');
    expect(out.data).toMatchObject({ grant: 'pending' });

    const own = host({
      plugins: {
        [CODEX_PLUGIN]: {
          mcp_servers: { router: { tools: { request: { approval_mode: 'prompt' } } } },
        },
      },
    });
    const kept = await runCodexInstall({ yes: true }, ctx(), own.deps);
    expect(own.steps.some((s) => s.startsWith('grant'))).toBe(false);
    expect(kept.data).toMatchObject({ grant: 'kept' });
  });

  it('writes no grant when the Codex config read timed out, and uninstall removes nothing', async () => {
    const unread = host(null);
    const out = await runCodexInstall({ yes: true }, ctx(), unread.deps);
    expect(unread.steps.some((s) => s.startsWith('grant'))).toBe(false);
    expect(out.data).toMatchObject({ grant: 'unread' });

    const gone = host(null);
    await expect(runCodexUninstall({}, ctx(), gone.deps)).rejects.toMatchObject({
      code: 'REFUSED',
    });
    expect(gone.steps).toEqual([]);
  });

  it('refuses project scope before any write', async () => {
    const { steps, deps } = host();
    await expect(runCodexInstall({ project: true }, ctx(), deps)).rejects.toThrow('user only');
    expect(steps).toEqual([]);
  });

  it('removes the plugin and marketplace, and drops the grant only when it is exactly approve', async () => {
    const ours = host(granted);
    await runCodexUninstall({}, ctx(), ours.deps);
    expect(ours.steps).toEqual([
      'codex plugin remove tenjin@tenjin',
      'codex plugin marketplace remove tenjin',
    ]);
    const theirs = host({
      plugins: {
        [CODEX_PLUGIN]: {
          mcp_servers: { router: { tools: { request: { approval_mode: 'prompt' } } } },
        },
      },
    });
    await runCodexUninstall({}, ctx(), theirs.deps);
    // Codex's remove drops the whole table, so the user's own value goes back.
    expect(theirs.steps).toEqual([
      'codex plugin remove tenjin@tenjin',
      'grant prompt',
      'codex plugin marketplace remove tenjin',
    ]);
  });

  it('refreshes only a plugin Codex already lists', async () => {
    const { steps, deps } = host();
    await expect(runCodexInstall({ refresh: true }, ctx(), deps)).rejects.toThrow(
      'Nothing to refresh',
    );
    expect(steps).toEqual(['codex plugin list']);
  });

  it('reads trust, the grant and the elicitation, writes nothing, and never calls the build a gate', async () => {
    const leg = (key: string, trustStatus = 'trusted') => ({
      key,
      pluginId: CODEX_PLUGIN,
      enabled: true,
      trustStatus,
    });
    const trusted = { data: [{ hooks: [leg('a'), leg('b'), leg('c')] }] };
    expect(hookTrust(trusted)).toBe('trusted');
    expect(hookTrust({ data: [{ hooks: [leg('a'), leg('b'), leg('c', 'untrusted')] }] })).toBe(
      'review',
    );
    expect(hookTrust(null)).toBe('unknown');
    expect(elicitationCanShow({ approval_policy: 'never' })).toBe(false);
    expect(elicitationCanShow({ approval_policy: 'on-request' })).toBe(true);
    expect(requestConfigured(granted)).toBe(true);
    expect(requestConfigured({ plugins: { [CODEX_PLUGIN]: { enabled: true } } })).toBe(false);

    const listed = JSON.stringify({
      installed: [{ pluginId: CODEX_PLUGIN, enabled: true, version: '0.1.0' }],
    });
    const { steps, deps } = host({ ...granted, approval_policy: 'never' });
    const ready = await runCodexDoctor({}, ctx(), {
      ...deps,
      run: async (args) => {
        steps.push(`codex ${args.join(' ')}`);
        return { code: 0, stdout: listed, stderr: '' };
      },
      hooks: async () => trusted,
    });
    expect(steps).toEqual(['codex plugin list --json']);
    expect(ready.data).toMatchObject({ ok: true, elicitation: false, version: '0.157.1' });
    expect(ready.humanLines?.join('\n')).toContain('information only');
    await expect(runCodexDoctor({}, ctx(), deps)).rejects.toMatchObject({ code: 'REFUSED' });
  });
});
